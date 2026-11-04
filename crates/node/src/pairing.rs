//! Pairing devices with this node (`doc/node.md#pairing`): the node's own key, the one-time offers its QR code
//! shows, and the devices paired so far, each with a token only its hash of is kept.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use gestalts_peer::paired::{PairingUri, fingerprint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paths::{Paths, write_atomic, write_secret};

/// How long a pairing offer (its QR code) stays valid.
pub const OFFER_TTL: Duration = Duration::from_secs(5 * 60);
/// Pairing attempts allowed per minute, so a secret can't be guessed.
const ATTEMPTS_PER_MINUTE: usize = 5;
/// How often `last_seen` is written back at most.
const SEEN_EVERY: Duration = Duration::from_secs(60);

/// The node's TLS certificate and key, made once and kept; its fingerprint is the node's id.
#[derive(Clone)]
pub struct NodeKey {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    pub id: String,
}

impl NodeKey {
    pub fn load_or_create(paths: &Paths) -> Result<NodeKey, String> {
        let (cert_file, key_file) = (paths.node_cert_file(), paths.node_key_file());
        if let (Ok(cert_der), Ok(key_der)) = (std::fs::read(&cert_file), std::fs::read(&key_file)) {
            return Ok(NodeKey { id: fingerprint(&cert_der), cert_der, key_der });
        }
        let made = rcgen::generate_simple_self_signed(vec!["gestalts-node".to_owned()]).map_err(|e| format!("cannot make the node's key: {e}"))?;
        let (cert_der, key_der) = (made.cert.der().to_vec(), made.key_pair.serialize_der());
        write_secret(&key_file, &key_der).map_err(|e| format!("cannot write {}: {e}", key_file.display()))?;
        write_secret(&cert_file, &cert_der).map_err(|e| format!("cannot write {}: {e}", cert_file.display()))?;
        Ok(NodeKey { id: fingerprint(&cert_der), cert_der, key_der })
    }

    pub fn tls_config(&self) -> Result<rustls::ServerConfig, String> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(vec![CertificateDer::from(self.cert_der.clone())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone())))
            .map_err(|e| format!("the node's key doesn't work: {e}"))
    }
}

/// A paired device, as `devices.json` keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    /// hex SHA-256 of its token
    token_sha256: String,
    paired_at: String,
    #[serde(default)]
    last_seen: Option<String>,
}

/// A paired device, as the app's settings show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen: Option<String>,
}

/// The QR code's content, for the app's settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Offer {
    pub uri: String,
    /// the QR code
    pub svg: String,
    pub addresses: Vec<String>,
    pub expires_in: u64,
}

/// What a device gets for a valid secret.
#[derive(Debug, Serialize, Deserialize)]
pub struct Paired {
    pub token: String,
    pub device_id: String,
    pub node_id: String,
}

#[derive(Debug, PartialEq)]
pub enum Refused {
    /// no offer open, or another secret
    Invalid,
    TooManyAttempts,
}

struct State {
    devices: Vec<Device>,
    /// the open offer's secret, until when
    offer: Option<(String, Instant)>,
    attempts: VecDeque<Instant>,
    saved_seen: Instant,
}

pub struct Pairing {
    file: PathBuf,
    state: Mutex<State>,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("the OS has randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Pairing {
    pub fn load(paths: &Paths) -> Pairing {
        let file = paths.devices_file();
        let devices = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Pairing { file, state: Mutex::new(State { devices, offer: None, attempts: VecDeque::new(), saved_seen: Instant::now() }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("pairing lock")
    }

    fn save(&self, devices: &[Device]) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(devices).expect("devices serialize");
        write_atomic(&self.file, &json).map_err(|e| format!("cannot write {}: {e}", self.file.display()))
    }

    /// Opens a new offer (replacing any open one) for the node `node_id`, named `name`, at `addresses`.
    pub fn offer(&self, node_id: &str, name: &str, addresses: Vec<String>) -> Offer {
        let secret = random_hex(16);
        self.lock().offer = Some((secret.clone(), Instant::now() + OFFER_TTL));
        let uri = PairingUri { node_id: node_id.to_owned(), addrs: addresses.clone(), secret, name: name.to_owned() }.to_string();
        let svg = qrcode::QrCode::new(uri.as_bytes())
            .map(|qr| qr.render::<qrcode::render::svg::Color<'_>>().min_dimensions(240, 240).quiet_zone(true).build())
            .unwrap_or_default();
        Offer { uri, svg, addresses, expires_in: OFFER_TTL.as_secs() }
    }

    pub fn cancel(&self) {
        self.lock().offer = None;
    }

    pub fn offer_open(&self) -> bool {
        self.lock().offer.as_ref().is_some_and(|(_, until)| Instant::now() < *until)
    }

    /// Whether the node should listen on the network: an offer is open, or a device is paired.
    pub fn wanted(&self) -> bool {
        self.offer_open() || !self.lock().devices.is_empty()
    }

    /// Pairs the device `name` if `secret` is the open offer's, which it closes.
    pub fn redeem(&self, node_id: &str, secret: &str, name: &str, now_iso: &str) -> Result<Paired, Refused> {
        let mut s = self.lock();
        let now = Instant::now();
        while s.attempts.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            s.attempts.pop_front();
        }
        if s.attempts.len() >= ATTEMPTS_PER_MINUTE {
            return Err(Refused::TooManyAttempts);
        }
        s.attempts.push_back(now);
        let valid = s.offer.as_ref().is_some_and(|(open, until)| now < *until && same(open, secret));
        if !valid {
            return Err(Refused::Invalid);
        }
        s.offer = None;
        let token = random_hex(32);
        let id = uuid::Uuid::new_v4().to_string();
        let name: String = name.trim().chars().filter(|c| !c.is_control()).take(80).collect();
        let name = if name.is_empty() { "A device".to_owned() } else { name };
        s.devices.push(Device { id: id.clone(), name, token_sha256: sha256_hex(&token), paired_at: now_iso.to_owned(), last_seen: Some(now_iso.to_owned()) });
        let devices = s.devices.clone();
        drop(s);
        if let Err(e) = self.save(&devices) { eprintln!("gestalts-node: {e}"); }
        Ok(Paired { token, device_id: id, node_id: node_id.to_owned() })
    }

    /// The paired device with this token, if any; notes that it was seen.
    pub fn check(&self, token: &str, now_iso: &str) -> Option<String> {
        let hash = sha256_hex(token);
        let mut s = self.lock();
        let i = s.devices.iter().position(|d| same(&d.token_sha256, &hash))?;
        s.devices[i].last_seen = Some(now_iso.to_owned());
        let id = s.devices[i].id.clone();
        if s.saved_seen.elapsed() > SEEN_EVERY {
            s.saved_seen = Instant::now();
            let devices = s.devices.clone();
            drop(s);
            if let Err(e) = self.save(&devices) { eprintln!("gestalts-node: {e}"); }
        }
        Some(id)
    }

    /// Unpairs a device; whether it was paired.
    pub fn forget(&self, id: &str) -> Result<bool, String> {
        let mut s = self.lock();
        let before = s.devices.len();
        s.devices.retain(|d| d.id != id);
        if s.devices.len() == before {
            return Ok(false);
        }
        let devices = s.devices.clone();
        drop(s);
        self.save(&devices).map(|()| true)
    }

    pub fn devices(&self) -> Vec<DeviceView> {
        self.lock().devices.iter().map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), paired_at: d.paired_at.clone(), last_seen: d.last_seen.clone() }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> Paths {
        let root = std::env::temp_dir().join(format!("gestalts-pairing-{}", uuid::Uuid::new_v4()));
        Paths { config: root.join("config"), data: root.join("data"), cache: root.join("cache") }
    }

    #[test]
    fn the_key_is_made_once() {
        let p = paths();
        let a = NodeKey::load_or_create(&p).unwrap();
        assert_eq!(a.id, NodeKey::load_or_create(&p).unwrap().id);
        assert_eq!(a.id.len(), 64);
        a.tls_config().unwrap();
    }

    #[test]
    fn an_offer_pairs_one_device_once() {
        let p = paths();
        let pairing = Pairing::load(&p);
        assert!(!pairing.wanted());
        let offer = pairing.offer("n", "PC", vec!["192.168.1.5:7718".into()]);
        assert!(pairing.wanted() && offer.svg.starts_with("<?xml"));
        let secret = PairingUri::parse(&offer.uri.replace("id=n", &format!("id={}", "a".repeat(64)))).unwrap().secret;
        assert_eq!(pairing.redeem("n", "wrong", "Phone", "t").unwrap_err(), Refused::Invalid);
        let paired = pairing.redeem("n", &secret, "Phone", "t").unwrap();
        assert_eq!(pairing.redeem("n", &secret, "Phone", "t").unwrap_err(), Refused::Invalid, "used up");
        assert_eq!(pairing.check(&paired.token, "t2"), Some(paired.device_id.clone()));
        assert_eq!(pairing.check("not-a-token", "t2"), None);
        // kept, without the token itself
        let saved = std::fs::read_to_string(p.devices_file()).unwrap();
        assert!(saved.contains("Phone") && !saved.contains(&paired.token));
        assert_eq!(Pairing::load(&p).devices().len(), 1);
        assert!(pairing.forget(&paired.device_id).unwrap());
        assert_eq!(pairing.check(&paired.token, "t3"), None);
        assert!(!pairing.wanted());
    }

    #[test]
    fn guessing_is_rate_limited() {
        let pairing = Pairing::load(&paths());
        pairing.offer("n", "PC", vec!["x:1".into()]);
        for _ in 0..ATTEMPTS_PER_MINUTE {
            assert_eq!(pairing.redeem("n", "guess", "x", "t").unwrap_err(), Refused::Invalid);
        }
        assert_eq!(pairing.redeem("n", "guess", "x", "t").unwrap_err(), Refused::TooManyAttempts);
    }
}
