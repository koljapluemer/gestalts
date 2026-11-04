//! A node on the home network, paired with this device (`doc/node.md#pairing`): its pairing URI (the QR code), pairing
//! with it, and reaching it again later, over TLS pinned to its certificate, with this device's token.
//!
//! Native only: a browser can't pin a certificate.

use std::sync::Arc;
use std::time::Duration;

use gestalts_core::storage::{Result, StorageError};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Peer;
use crate::fetch::{Auth, Payload, json, send};

/// The URI scheme of a pairing offer.
pub const PAIRING_SCHEME: &str = "gestalts-pair:";
/// The mDNS service type a node with paired devices advertises.
pub const MDNS_SERVICE: &str = "_gestalts._tcp.local.";
/// The oldest node API a paired peer syncs with (it needs `/sync/*`).
pub const MIN_API: u64 = 2;

fn io(e: impl std::fmt::Display) -> StorageError {
    StorageError::Io(e.to_string())
}

/// Hex SHA-256 of a certificate's DER: a node's id.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02x}")).collect()
}

/// What the desktop's QR code holds:
/// `gestalts-pair:?v=1&id=<fingerprint>&addr=<ip:port>,…&secret=<one-time secret>&name=<the desktop's name>`.
#[derive(Debug, Clone, PartialEq)]
pub struct PairingUri {
    /// the node's certificate fingerprint
    pub node_id: String,
    /// `ip:port` to try, in order
    pub addrs: Vec<String>,
    pub secret: String,
    /// the node's name, to show
    pub name: String,
}

impl PairingUri {
    pub fn parse(uri: &str) -> Result<Self> {
        let query = uri.trim().strip_prefix(PAIRING_SCHEME).ok_or_else(|| io("not a pairing code"))?;
        let query = query.strip_prefix('?').unwrap_or(query);
        let (mut v, mut node_id, mut addrs, mut secret, mut name) = (None, None, Vec::new(), None, String::new());
        for pair in query.split('&') {
            let (k, val) = pair.split_once('=').unwrap_or((pair, ""));
            let val = decode(val);
            match k {
                "v" => v = Some(val),
                "id" => node_id = Some(val),
                "addr" => addrs = val.split(',').filter(|a| !a.is_empty()).map(str::to_owned).collect(),
                "secret" => secret = Some(val),
                "name" => name = val,
                _ => {}
            }
        }
        if v.as_deref() != Some("1") {
            return Err(io("a pairing code from a newer version: update this app"));
        }
        match (node_id, secret) {
            (Some(node_id), Some(secret)) if !addrs.is_empty() && node_id.len() == 64 => Ok(PairingUri { node_id, addrs, secret, name }),
            _ => Err(io("an incomplete pairing code")),
        }
    }
}

impl std::fmt::Display for PairingUri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use crate::fetch::enc;
        write!(f, "{PAIRING_SCHEME}?v=1&id={}&addr={}&secret={}&name={}", self.node_id, enc(&self.addrs.join(",")), enc(&self.secret), enc(&self.name))
    }
}

/// Undoes `encodeURIComponent` (and `+` as a space).
fn decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1).copied().and_then(hex), b.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
            (b'+', ..) => out.push(b' '),
            (c, ..) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A node this device paired with: what the app keeps (privately: `token` is a password) to reach it again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairedNode {
    /// the node's certificate fingerprint
    pub node_id: String,
    pub name: String,
    /// `ip:port` to try, the last one that worked first
    pub addrs: Vec<String>,
    /// this device's id at the node, which lists it under it
    pub device_id: String,
    pub token: String,
}

/// Accepts exactly one certificate, whatever its name: the node's, by fingerprint.
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime)
        -> std::result::Result<ServerCertVerified, rustls::Error> {
        if fingerprint(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("not the paired device: its certificate changed".into()))
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct)
        -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct)
        -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// An HTTP client that talks only to the node with this certificate fingerprint.
pub fn pinned_client(node_id: &str) -> Result<reqwest::Client> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Pinned { fingerprint: node_id.to_owned(), provider: provider.clone() };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(io)
}

fn url(addr: &str) -> String {
    format!("https://{addr}")
}

/// Pairs this device (shown at the node as `device_name`) with the node whose code is `uri`: tries each address,
/// over TLS pinned to the node's certificate.
pub async fn pair(uri: &PairingUri, device_name: &str) -> Result<PairedNode> {
    #[derive(Deserialize)]
    struct Paired {
        token: String,
        device_id: String,
    }
    let client = pinned_client(&uri.node_id)?;
    let body = serde_json::to_vec(&serde_json::json!({ "secret": uri.secret, "name": device_name })).map_err(io)?;
    let mut last_error = io("no address to try");
    for (i, addr) in uri.addrs.iter().enumerate() {
        let auth = Auth { token: None, client: Some(client.clone()) };
        match send(&auth, &format!("{}/pair", url(addr)), "POST", Some(Payload::Json(body.clone()))).await {
            Ok(Some(r)) => {
                let p: Paired = json(r).await?;
                let mut addrs = uri.addrs.clone();
                addrs.swap(0, i);
                return Ok(PairedNode { node_id: uri.node_id.clone(), name: uri.name.clone(), addrs, device_id: p.device_id, token: p.token });
            }
            Ok(None) => last_error = io("that device can't pair: update its app"),
            // refused: it answered, so the other addresses won't do better
            Err(e) if is_refusal(&e) => return Err(io("the pairing code expired or was used already: show a new one")),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

fn is_refusal(e: &StorageError) -> bool {
    let s = e.to_string();
    s.contains(": 403") || s.contains(": 429")
}

/// The node, reached at the first address that answers as it: its known addresses, then any mDNS finds. Puts the one
/// that answered first in `node.addrs` (save it). Fails if the node isn't on this network, or too old to sync with.
pub async fn connect(node: &mut PairedNode) -> Result<Peer> {
    if let Some(p) = connect_to(node, node.addrs.clone()).await? {
        return Ok(p);
    }
    let found = discover(&node.node_id, Duration::from_secs(3)).await;
    let fresh: Vec<String> = found.into_iter().filter(|a| !node.addrs.contains(a)).collect();
    connect_to(node, fresh).await?.ok_or_else(|| io(format!("{} isn't reachable on this network", node.name)))
}

async fn connect_to(node: &mut PairedNode, addrs: Vec<String>) -> Result<Option<Peer>> {
    let client = pinned_client(&node.node_id)?;
    for addr in addrs {
        let peer = Peer::with_auth(&url(&addr), Auth { token: Some(node.token.clone()), client: Some(client.clone()) });
        let Ok(health) = peer.health().await else { continue };
        if health["api"].as_u64().unwrap_or(1) < MIN_API {
            return Err(io(format!("{} runs an older version: update it", node.name)));
        }
        node.addrs.retain(|a| *a != addr);
        node.addrs.insert(0, addr);
        return Ok(Some(peer));
    }
    Ok(None)
}

/// Addresses (`ip:port`) where mDNS finds the node `node_id` within `timeout`; empty if multicast doesn't work here.
/// (On Android, the app has to hold a `WifiManager.MulticastLock` meanwhile.)
pub async fn discover(node_id: &str, timeout: Duration) -> Vec<String> {
    let node_id = node_id.to_owned();
    tokio::task::spawn_blocking(move || discover_blocking(&node_id, timeout)).await.unwrap_or_default()
}

fn discover_blocking(node_id: &str, timeout: Duration) -> Vec<String> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return vec![] };
    let Ok(events) = daemon.browse(MDNS_SERVICE) else { return vec![] };
    let mut deadline = std::time::Instant::now() + timeout;
    let mut out: Vec<String> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match events.recv_timeout(left) {
            // its addresses may come in several answers, one per interface: collect a moment longer once one did
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) if info.get_property_val_str("id") == Some(node_id) => {
                let port = info.get_port();
                // IPv4 only: link-local IPv6 addresses need a scope a URL can't carry
                for a in info.get_addresses().iter().filter(|a| a.is_ipv4()) {
                    let addr = format!("{a}:{port}");
                    if !out.contains(&addr) {
                        out.push(addr);
                    }
                }
                if !out.is_empty() {
                    deadline = deadline.min(std::time::Instant::now() + Duration::from_millis(300));
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    out
}

/// What a device stores its sync base with a paired node under: per node and folder, not per address, which can
/// change. (The node's folder id is in its `/health`.)
pub fn base_name(node_id: &str, folder_id: &str) -> String {
    format!("{}-{}", &node_id[..node_id.len().min(16)], folder_id).chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_uris_round_trip() {
        let uri = PairingUri { node_id: "a".repeat(64), addrs: vec!["192.168.1.5:7718".into(), "10.0.0.2:7718".into()], secret: "s3cr3t".into(), name: "Kolja's PC".into() };
        let text = uri.to_string();
        assert!(text.starts_with("gestalts-pair:?v=1&id="));
        assert_eq!(PairingUri::parse(&text).unwrap(), uri);
        assert!(PairingUri::parse("https://evil.example").is_err());
        assert!(PairingUri::parse("gestalts-pair:?v=2&id=x").is_err());
        assert!(PairingUri::parse(&text.replace("&addr=", "&nothing=")).is_err());
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(decode("a%20b%2Cc%C3%A9+d%"), "a b,cé d%");
    }

    #[test]
    fn base_names_are_safe() {
        assert_eq!(base_name(&"ab".repeat(32), "f/1"), "abababababababab-f_1");
    }
}
