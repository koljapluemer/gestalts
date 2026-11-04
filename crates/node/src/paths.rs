//! Where the connector keeps its own files, per OS (XDG on Linux, Application Support on macOS,
//! AppData on Windows), and the small config file that remembers the chosen folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Paths {
    /// config.json and the control token
    pub config: PathBuf,
    /// managed uv, Python, built-in and user plugins
    pub data: PathBuf,
    /// plugin environments and uv's download cache
    pub cache: PathBuf,
}

impl Paths {
    /// `profile` keeps e.g. a dev connector (`--profile dev`) from touching the installed one's settings.
    pub fn new(profile: Option<&str>) -> Result<Self, String> {
        let name = profile.map_or_else(|| "gestalts".to_owned(), |p| format!("gestalts-{p}"));
        let dirs = directories::ProjectDirs::from("com", "koljasam", &name).ok_or("cannot find a home directory")?;
        Ok(Paths { config: dirs.config_dir().into(), data: dirs.data_local_dir().into(), cache: dirs.cache_dir().into() })
    }

    pub fn config_file(&self) -> PathBuf { self.config.join("config.json") }
    pub fn control_token_file(&self) -> PathBuf { self.config.join("control-token") }
    /// the node's TLS certificate and key for the home network (DER), whose fingerprint is its id
    pub fn node_cert_file(&self) -> PathBuf { self.config.join("node.crt") }
    pub fn node_key_file(&self) -> PathBuf { self.config.join("node.key") }
    /// the devices paired with this node
    pub fn devices_file(&self) -> PathBuf { self.config.join("devices.json") }
    /// plugins the user added themselves, next to the built-in ones
    pub fn user_plugins(&self) -> PathBuf { self.data.join("plugins") }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// the data folder (notes/ + blobs/) opened last
    pub folder: Option<PathBuf>,
    /// web origins allowed to connect besides localhost and the app's own frontends
    pub extra_origins: Vec<String>,
}

impl Config {
    pub fn load(paths: &Paths) -> Config {
        std::fs::read(paths.config_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths) -> std::io::Result<()> {
        write_atomic(&paths.config_file(), &serde_json::to_vec_pretty(self).expect("config serializes"))
    }
}

/// Writes via a temporary file and a rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)
}

/// Writes a secret (the per-run control token, the node's key), readable only by this user.
pub fn write_secret(path: &Path, secret: impl AsRef<[u8]>) -> std::io::Result<()> {
    let secret = secret.as_ref();
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
        f.write_all(secret)
    }
    #[cfg(not(unix))]
    { std::fs::write(path, secret) }
}
