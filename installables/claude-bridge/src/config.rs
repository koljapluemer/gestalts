//! Where the bridge keeps its files (per OS: XDG on Linux, Application Support on macOS, AppData on Windows): the
//! sites allowed to use it, their workspaces and the run logs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Paths {
    /// the allowed sites (tokens.json) and the settings
    pub config: PathBuf,
    /// workspaces and run logs
    pub data: PathBuf,
}

impl Paths {
    /// `profile` keeps a development bridge (`--profile dev`) apart from an installed one.
    pub fn new(profile: Option<&str>) -> Result<Paths, String> {
        let name = profile.map_or_else(|| "gestalts-claude-bridge".to_owned(), |p| format!("gestalts-claude-bridge-{p}"));
        let dirs = directories::ProjectDirs::from("com", "koljasam", &name).ok_or("cannot find a home directory")?;
        Ok(Paths { config: dirs.config_dir().into(), data: dirs.data_local_dir().into() })
    }

    pub fn tokens_file(&self) -> PathBuf { self.config.join("tokens.json") }
    pub fn settings_file(&self) -> PathBuf { self.config.join("settings.json") }
    pub fn workspaces(&self) -> PathBuf { self.data.join("workspaces") }
    pub fn runs(&self) -> PathBuf { self.data.join("runs") }
}

/// The sites allowed to run Claude here: origin -> its token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tokens(pub BTreeMap<String, String>);

impl Tokens {
    pub fn load(paths: &Paths) -> Tokens {
        std::fs::read(paths.tokens_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths) -> std::io::Result<()> {
        write_secret(&paths.tokens_file(), serde_json::to_vec_pretty(self).expect("tokens serialize"))
    }

    /// Whether `token` is the one `origin` was given.
    pub fn allows(&self, origin: &str, token: &str) -> bool {
        self.0.get(origin).is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes()))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "Start on login" was offered once, on the first start
    pub autostart_offered: bool,
}

impl Settings {
    pub fn load(paths: &Paths) -> Settings {
        std::fs::read(paths.settings_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths) -> std::io::Result<()> {
        write_atomic(&paths.settings_file(), &serde_json::to_vec_pretty(self).expect("settings serialize"))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Writes via a temporary file and a rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)
}

/// Writes a secret, readable only by this user.
pub fn write_secret(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes.as_ref())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, bytes.as_ref())?;
    std::fs::rename(tmp, path)
}
