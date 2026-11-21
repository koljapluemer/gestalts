//! Finding the claude CLI. Started from the app menu or on login, the bridge has a thin PATH, so the places the
//! installers put it are looked at too.

use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Claude {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

const NAMES: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };

/// `$GESTALTS_CLAUDE`, else `claude` on PATH, else where its installers put it.
pub fn find() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("GESTALTS_CLAUDE") { return Some(PathBuf::from(p)); }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = directories::BaseDirs::new().map(|b| b.home_dir().to_owned()) {
        dirs.extend([home.join(".claude/local"), home.join(".local/bin"), home.join(".npm-global/bin"), home.join(".bun/bin"),
                     home.join("AppData/Roaming/npm")]);
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    dirs.iter().flat_map(|d| NAMES.iter().map(move |n| d.join(n))).find(|p| is_file(p))
}

fn is_file(p: &Path) -> bool { p.is_file() }

/// What `claude --version` says, waiting at most a few seconds.
pub fn probe() -> Claude {
    let Some(path) = find() else { return Claude { found: false, path: None, version: None } };
    let mut cmd = std::process::Command::new(&path);
    cmd.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let version = cmd.spawn().ok().and_then(|mut child| {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => { let _ = child.kill(); return None; }
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(child.stdout.as_mut()?, &mut out).ok()?;
        Some(out.trim().to_owned()).filter(|v| !v.is_empty())
    });
    Claude { found: version.is_some(), path: Some(path), version }
}
