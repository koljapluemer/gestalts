//! Finds `uv`, which runs the Python plugin workers, or downloads a pinned release into the app's
//! data folder. With uv in place, plugins need nothing else installed: uv fetches Python itself.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The release downloaded when no usable uv is installed.
pub const VERSION: &str = "0.13.6";
/// An installed uv older than this is ignored in favour of the pinned download.
const MIN_INSTALLED: (u32, u32) = (0, 9);

/// Release asset and its SHA-256 per platform (from the release's `.sha256` files).
const ASSETS: &[(&str, &str, &str, &str)] = &[
    ("linux", "x86_64", "uv-x86_64-unknown-linux-musl.tar.gz", "5d61f26b6c7213779eda90edc6971ea6b0b796bfb8d49a574c8ad69b59838548"),
    ("linux", "aarch64", "uv-aarch64-unknown-linux-musl.tar.gz", "819692e404d23e5aae6bc44c0e260f1f5492fd1910ab4693b2c650f926dbe800"),
    ("macos", "x86_64", "uv-x86_64-apple-darwin.tar.gz", "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02"),
    ("macos", "aarch64", "uv-aarch64-apple-darwin.tar.gz", "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472"),
    ("windows", "x86_64", "uv-x86_64-pc-windows-msvc.zip", "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f"),
    ("windows", "aarch64", "uv-aarch64-pc-windows-msvc.zip", "c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum UvState {
    Locating,
    Downloading,
    Ready { path: PathBuf, version: String },
    Failed { error: String },
}

const EXE: &str = if cfg!(windows) { "uv.exe" } else { "uv" };

/// `GESTALTS_UV`, else a recent enough `uv` on PATH, else the pinned release under `data/uv/`
/// (downloading it if needed; `on_download` is called before that starts).
pub async fn locate(data: &Path, on_download: impl FnOnce()) -> Result<(PathBuf, String), String> {
    if let Some(path) = std::env::var_os("GESTALTS_UV") {
        let path = PathBuf::from(path);
        let version = version_of(&path).await.ok_or_else(|| format!("GESTALTS_UV={} does not run", path.display()))?;
        return Ok((path, version));
    }
    if let Some(version) = version_of(Path::new(EXE)).await
        && parse(&version).is_some_and(|v| v >= MIN_INSTALLED) {
        return Ok((PathBuf::from(EXE), version));
    }
    let managed = data.join("uv").join(VERSION).join(EXE);
    if !managed.is_file() {
        on_download();
        download(&managed).await?;
    }
    let version = version_of(&managed).await.ok_or("the downloaded uv does not run")?;
    Ok((managed, version))
}

async fn version_of(exe: &Path) -> Option<String> {
    let out = tokio::process::Command::new(exe).arg("--version").stdin(Stdio::null()).output().await.ok()?;
    // "uv 0.13.6 (abc 2026-10-01)"
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).split_whitespace().nth(1).unwrap_or("").to_owned())
}

fn parse(version: &str) -> Option<(u32, u32)> {
    let mut it = version.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

fn asset() -> Result<(&'static str, &'static str), String> {
    ASSETS.iter().find(|(os, arch, ..)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH)
        .map(|(_, _, name, sha)| (*name, *sha))
        .ok_or_else(|| format!("no uv download for {}-{}; install uv yourself", std::env::consts::OS, std::env::consts::ARCH))
}

async fn download(dest: &Path) -> Result<(), String> {
    let (name, sha) = asset()?;
    let url = format!("https://github.com/astral-sh/uv/releases/download/{VERSION}/{name}");
    let bytes = reqwest::get(&url).await.and_then(reqwest::Response::error_for_status).map_err(|e| format!("cannot download uv: {e}"))?
        .bytes().await.map_err(|e| format!("cannot download uv: {e}"))?;
    let got = hex(&Sha256::digest(&bytes));
    if got != sha { return Err(format!("uv download has checksum {got}, expected {sha}")); }
    let exe = extract(name, &bytes).map_err(|e| format!("cannot unpack uv: {e}"))?;
    let dir = dest.parent().expect("dest is in a folder");
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, exe).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// The `uv` executable out of a release archive.
fn extract(name: &str, bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let not_found = || std::io::Error::new(std::io::ErrorKind::NotFound, format!("no {EXE} in {name}"));
    if name.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(std::io::Error::other)?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(std::io::Error::other)?;
            let name = file.name().map_err(std::io::Error::other)?.into_owned();
            if Path::new(&name).file_name().is_some_and(|n| n == EXE) {
                let mut out = Vec::new();
                file.read_to_end(&mut out)?;
                return Ok(out);
            }
        }
        return Err(not_found());
    }
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()?.file_name().is_some_and(|n| n == EXE) {
            let mut out = Vec::new();
            entry.read_to_end(&mut out)?;
            return Ok(out);
        }
    }
    Err(not_found())
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_release_target_has_a_download() {
        for (os, arch) in [("linux", "x86_64"), ("linux", "aarch64"), ("macos", "x86_64"), ("macos", "aarch64"), ("windows", "x86_64"), ("windows", "aarch64")] {
            let found = ASSETS.iter().find(|(o, a, ..)| *o == os && *a == arch).expect("asset for target");
            assert_eq!(found.3.len(), 64, "sha256 for {os}-{arch}");
        }
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse("0.13.6"), Some((0, 13)));
        assert!(parse("0.9.13").is_some_and(|v| v >= MIN_INSTALLED));
        assert!(parse("0.8.2").is_some_and(|v| v < MIN_INSTALLED));
        assert_eq!(parse("garbage"), None);
    }
}
