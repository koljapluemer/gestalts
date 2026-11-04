//! The node on the home network (`doc/node.md#pairing`): a TLS listener with the node's own certificate, for paired
//! devices only, advertised by mDNS. It runs only while a pairing offer is open or a device is paired.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::pairing::{NodeKey, Offer, OFFER_TTL, Pairing};
use crate::paths::Paths;
use crate::server::AppState;

/// The default port on the home network (the API on 127.0.0.1 is 7717).
pub const LAN_PORT: u16 = 7718;

/// What the app's settings show about the home network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanView {
    pub listening: bool,
    pub port: u16,
    /// `ip:port` where devices on the network reach this node
    pub addresses: Vec<String>,
    pub node_id: String,
    pub pairing_open: bool,
}

struct Running {
    port: u16,
    stop: watch::Sender<bool>,
    mdns: Option<mdns_sd::ServiceDaemon>,
}

pub struct Lan {
    port: u16,
    key: NodeKey,
    tls: Arc<rustls::ServerConfig>,
    pub pairing: Pairing,
    /// this computer's name, shown on the device that pairs
    name: String,
    running: Mutex<Option<Running>>,
}

/// Bridges of containers and virtual machines on this computer: no other device reaches it there.
fn is_virtual(interface: &str) -> bool {
    ["docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "cni", "flannel", "podman", "lxcbr", "lxdbr"].iter().any(|p| interface.starts_with(p))
}

/// This computer's IPv4 addresses on its networks.
fn local_ips() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && i.ip().is_ipv4() && !is_virtual(&i.name))
        .map(|i| i.ip())
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

/// This computer's name, as the OS knows it.
pub fn host_name() -> String {
    let from_env = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok();
    let from_file = || std::fs::read_to_string("/etc/hostname").ok();
    from_env.or_else(from_file).map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Gestalts".to_owned())
}

impl Lan {
    /// `port` 0 picks a free one (tests).
    pub fn new(paths: &Paths, port: u16) -> Result<Lan, String> {
        let key = NodeKey::load_or_create(paths)?;
        let tls = Arc::new(key.tls_config()?);
        Ok(Lan { port, key, tls, pairing: Pairing::load(paths), name: host_name(), running: Mutex::new(None) })
    }

    pub fn node_id(&self) -> &str {
        &self.key.id
    }

    fn port_now(&self) -> Option<u16> {
        self.running.lock().expect("lan lock").as_ref().map(|r| r.port)
    }

    pub fn view(&self) -> LanView {
        let port = self.port_now();
        LanView {
            listening: port.is_some(),
            port: port.unwrap_or(self.port),
            addresses: port.map(|p| local_ips().into_iter().map(|ip| SocketAddr::new(ip, p).to_string()).collect()).unwrap_or_default(),
            node_id: self.key.id.clone(),
            pairing_open: self.pairing.offer_open(),
        }
    }

    /// Opens a pairing offer and listens until it's used or expires.
    pub fn offer(self: &Arc<Self>, state: &AppState) -> Result<Offer, String> {
        // listening first, so the offer has the port
        self.pairing.offer(&self.key.id, &self.name, vec![]);
        self.update(state)?;
        let addresses = self.view().addresses;
        if addresses.is_empty() {
            self.pairing.cancel();
            self.update(state)?;
            return Err("this computer isn't connected to a network".into());
        }
        let offer = self.pairing.offer(&self.key.id, &self.name, addresses);
        let (lan, state) = (self.clone(), state.clone());
        tokio::spawn(async move {
            tokio::time::sleep(OFFER_TTL + std::time::Duration::from_secs(1)).await;
            if let Err(e) = lan.update(&state) { eprintln!("gestalts-node: {e}"); }
        });
        Ok(offer)
    }

    /// Starts or stops listening, as pairing wants it. Needs a tokio runtime.
    pub fn update(&self, state: &AppState) -> Result<(), String> {
        let mut running = self.running.lock().expect("lan lock");
        match (self.pairing.wanted(), running.is_some()) {
            (true, false) => *running = Some(self.start(state)?),
            (false, true) => {
                if let Some(r) = running.take() { stop(r); }
            }
            _ => {}
        }
        Ok(())
    }

    fn start(&self, state: &AppState) -> Result<Running, String> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let std_listener = std::net::TcpListener::bind(addr).map_err(|e| format!("cannot listen on the network ({addr}): {e}"))?;
        std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
        let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| e.to_string())?;
        let (stop, stopped) = watch::channel(false);
        let acceptor = tokio_rustls::TlsAcceptor::from(self.tls.clone());
        tokio::spawn(serve(listener, acceptor, crate::server::lan_app(state.clone()), stopped));
        let mdns = advertise(&self.key.id, port).map_err(|e| eprintln!("gestalts-node: not advertising on the network (mDNS): {e}")).ok();
        Ok(Running { port, stop, mdns })
    }

    /// Stops listening (the node is shutting down).
    pub fn shutdown(&self) {
        if let Some(r) = self.running.lock().expect("lan lock").take() { stop(r); }
    }
}

fn stop(r: Running) {
    let _ = r.stop.send(true);
    if let Some(d) = r.mdns { let _ = d.shutdown(); }
}

/// Serves `app` over TLS until `stop`; ends open connections then too, so a forgotten device is cut off at once.
async fn serve(listener: tokio::net::TcpListener, acceptor: tokio_rustls::TlsAcceptor, app: axum::Router, mut stop: watch::Receiver<bool>) {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    loop {
        let (tcp, _) = tokio::select! {
            _ = stop.changed() => return,
            r = listener.accept() => match r { Ok(c) => c, Err(_) => continue },
        };
        let (acceptor, app, mut stop) = (acceptor.clone(), app.clone(), stop.clone());
        tokio::spawn(async move {
            let Ok(Ok(tls)) = tokio::time::timeout(std::time::Duration::from_secs(10), acceptor.accept(tcp)).await else { return };
            let service = hyper_util::service::TowerToHyperService::new(app);
            let builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
            let conn = builder.serve_connection_with_upgrades(TokioIo::new(tls), service);
            tokio::select! {
                _ = conn => {}
                _ = stop.changed() => {}
            }
        });
    }
}

/// Advertises the node as `_gestalts._tcp` with its id, so paired devices find it when its address changed.
fn advertise(node_id: &str, port: u16) -> Result<mdns_sd::ServiceDaemon, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    // as in the pairing code: IPv4, and not on container or VM bridges
    let _ = daemon.disable_interface(mdns_sd::IfKind::IPv6);
    for i in if_addrs::get_if_addrs().unwrap_or_default().into_iter().filter(|i| is_virtual(&i.name)) {
        let _ = daemon.disable_interface(mdns_sd::IfKind::Name(i.name));
    }
    let short = &node_id[..12];
    let ips = local_ips();
    let info = mdns_sd::ServiceInfo::new(gestalts_peer::paired::MDNS_SERVICE, &format!("gestalts-{short}"), &format!("gestalts-{short}.local."),
                                         &ips[..], port, &[("id", node_id)][..])
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
    daemon.register(info).map_err(|e| e.to_string())?;
    Ok(daemon)
}
