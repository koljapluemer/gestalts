//! `plugin.yml`, and the bundle around it: pure, no IO beyond reading the bundle. Running backends is `plugins.rs`.
//!
//! A plugin is a folder: `plugin.yml`, `view.tsx`, and optionally `gestalts/<name>/v<N>.yml`, `decks/<id>/` and
//! `backend.py`. What it holds is what's in the folder; the manifest only says what can't be seen there.

use std::path::{Path, PathBuf};

use gestalts_core::{Gestalts, Yml, YmlState};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("cannot read {0}: {1}")]
    Read(PathBuf, std::io::Error),
    #[error("invalid plugin manifest: {0}")]
    Yaml(#[from] serde_yaml_ng::Error),
    #[error("invalid plugin manifest: {0}")]
    Invalid(String),
}

fn invalid<T>(m: impl Into<String>) -> Result<T, ManifestError> {
    Err(ManifestError::Invalid(m.into()))
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Requirement {
    /// its view needs `backend.py` running; hosts without one hide the view
    Backend,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `name@N` of the gestalts it may read
    #[serde(default)]
    pub reads: Vec<String>,
    /// `name@N` of the gestalts it may write
    #[serde(default)]
    pub writes: Vec<String>,
    /// e.g. `learning`, how a shell finds its views
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub requires: Vec<Requirement>,
    /// asks to run in the app's origin; the distribution decides whether it does
    #[serde(default)]
    pub frame: Option<FrameMode>,
    /// hosts its view may reach through the node's `/net`, exactly
    #[serde(default)]
    pub network: Vec<String>,
    /// its view asks for completions through the node's `/llm`
    #[serde(default)]
    pub llm: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum FrameMode {
    #[serde(rename = "same-origin")]
    SameOrigin,
}

#[derive(Debug, Clone)]
pub struct PluginBundle {
    pub root: PathBuf,
    pub manifest: PluginManifest,
    gestalt_texts: Vec<String>,
}

impl PluginBundle {
    pub fn load(root: impl Into<PathBuf>) -> Result<Self, ManifestError> {
        let root = root.into();
        let path = root.join("plugin.yml");
        let text = std::fs::read_to_string(&path).map_err(|e| ManifestError::Read(path, e))?;
        let manifest: PluginManifest = serde_yaml_ng::from_str(&text)?;
        validate(&manifest)?;
        // a backend.py without `requires: [backend]` is optional: the view works without it, and better with it
        if manifest.requires.contains(&Requirement::Backend) && !root.join("backend.py").is_file() {
            return invalid(format!("{}: `requires: [backend]` but there's no backend.py", manifest.id));
        }
        let gestalt_texts = read_gestalts(&root)?;
        Gestalts::from_yaml(&gestalt_texts.iter().map(String::as_str).collect::<Vec<_>>()).map_err(ManifestError::Invalid)?;
        Ok(Self { root, manifest, gestalt_texts })
    }

    /// The definitions of the gestalts this plugin owns, as YAML.
    pub fn gestalt_texts(&self) -> &[String] {
        &self.gestalt_texts
    }

    /// Its `backend.py`, required or optional.
    pub fn backend(&self) -> Option<PathBuf> {
        Some(self.root.join("backend.py")).filter(|p| p.is_file())
    }
}

/// Every `gestalts/<name>/v<N>.yml` in the bundle, in a stable order.
fn read_gestalts(root: &Path) -> Result<Vec<String>, ManifestError> {
    let dir = root.join("gestalts");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let read = |p: &Path| std::fs::read_dir(p).map_err(|e| ManifestError::Read(p.to_owned(), e));
    let mut files = Vec::new();
    for name in read(&dir)?.flatten().filter(|e| e.path().is_dir()) {
        files.extend(read(&name.path())?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "yml")));
    }
    files.sort();
    files.iter().map(|p| std::fs::read_to_string(p).map_err(|e| ManifestError::Read(p.clone(), e))).collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn valid_version(v: &str) -> bool {
    let mut parts = v.split('.');
    parts.by_ref().take(3).count() == 3 && parts.next().is_none() && v.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

fn valid_gestalt(id: &str) -> bool {
    id.split_once('@').is_some_and(|(name, version)| valid_id(name) && version.parse::<u32>().is_ok_and(|n| n >= 1))
}

fn validate(m: &PluginManifest) -> Result<(), ManifestError> {
    if !valid_id(&m.id) {
        return invalid(format!("invalid plugin id {}", m.id));
    }
    if !valid_version(&m.version) {
        return invalid(format!("invalid version {}", m.version));
    }
    if m.title.trim().is_empty() {
        return invalid(format!("{} has no title", m.id));
    }
    if let Some(g) = m.reads.iter().chain(&m.writes).find(|g| !valid_gestalt(g)) {
        return invalid(format!("gestalt {g} is not name@N"));
    }
    if let Some(g) = m.writes.iter().find(|g| !m.reads.contains(g)) {
        return invalid(format!("{} writes {g} but doesn't read it", m.id));
    }
    if let Some(h) = m.network.iter().find(|h| !valid_host(h)) {
        return invalid(format!("{}: network host {h} is not a plain host name (like www.example.com)", m.id));
    }
    Ok(())
}

/// A DNS name with at least one dot: no scheme, port, path or wildcard.
pub fn valid_host(h: &str) -> bool {
    h.contains('.') && h.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
        && l.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
}

/// The core's gestalts plus every plugin's: each defined once, and every gestalt a plugin reads existing.
pub fn gestalts_with(bundles: &[&PluginBundle]) -> Result<Gestalts, String> {
    let texts: Vec<&str> = bundles.iter().flat_map(|b| b.gestalt_texts()).map(String::as_str).collect();
    let g = Gestalts::builtin_with(&texts)?;
    for b in bundles {
        if let Some(missing) = b.manifest.reads.iter().find(|id| g.get(id).is_none()) {
            return Err(format!("{} reads {missing}, which nothing defines", b.manifest.id));
        }
    }
    Ok(g)
}

/// What a plugin's backend may touch through the node API.
#[derive(Debug, Clone, Default)]
pub struct AccessPolicy {
    reads: Vec<String>,
    writes: Vec<String>,
}

impl AccessPolicy {
    pub fn of(manifest: &PluginManifest) -> Self {
        AccessPolicy { reads: manifest.reads.clone(), writes: manifest.writes.clone() }
    }

    fn gestalt_in(list: &[String], id: &str, text: &str, gestalts: &Gestalts) -> bool {
        matches!(gestalts.classify(&Yml::parse(id, text)), YmlState::Valid(g) if list.contains(&g))
    }

    pub fn can_read(&self, id: &str, text: &str, gestalts: &Gestalts) -> bool {
        Self::gestalt_in(&self.reads, id, text, gestalts)
    }

    /// Only a valid yml of a gestalt it may write.
    pub fn can_write(&self, id: &str, text: &str, gestalts: &Gestalts) -> bool {
        Self::gestalt_in(&self.writes, id, text, gestalts)
    }

    /// Blob names are hashes and blobs have no gestalt: a backend that reads anything may read blobs.
    pub fn can_read_blobs(&self) -> bool {
        !self.reads.is_empty()
    }

    pub fn can_write_blobs(&self) -> bool {
        !self.writes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn bundle(name: &str, manifest: &str, files: &[(&str, &str)]) -> (Dir, Result<PluginBundle, ManifestError>) {
        let dir = std::env::temp_dir().join(format!("gestalts-plugin-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.yml"), manifest).unwrap();
        for (path, text) in files {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        let b = PluginBundle::load(&dir);
        (Dir(dir), b)
    }

    const BASE: &str = "id: x\nversion: 1.0.0\ntitle: X\n";

    #[test]
    fn frame_network_and_llm_are_read_and_hosts_checked() {
        let (_d, b) = bundle("caps", &format!("{BASE}frame: same-origin\nnetwork: [www.youtube.com]\nllm: true\n"), &[]);
        let m = b.unwrap().manifest;
        assert_eq!(m.frame, Some(FrameMode::SameOrigin));
        assert_eq!(m.network, vec!["www.youtube.com".to_owned()]);
        assert!(m.llm);
        for bad in ["https://www.youtube.com", "*.youtube.com", "localhost", "www.youtube.com:443"] {
            let (_d, b) = bundle("caps-bad", &format!("{BASE}network: ['{bad}']\n"), &[]);
            assert!(b.is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn a_minimal_plugin_is_three_lines() {
        let (_d, b) = bundle("min", BASE, &[]);
        assert_eq!(b.unwrap().manifest.id, "x");
    }

    #[test]
    fn manifests_are_checked() {
        for (i, bad) in [
            "id: X\nversion: 1.0.0\ntitle: X\n",
            "id: x\nversion: 1.0\ntitle: X\n",
            "id: x\nversion: 1.0.0\ntitle: ' '\n",
            "id: x\nversion: 1.0.0\ntitle: X\npanes: []\n",
            "id: x\nversion: 1.0.0\ntitle: X\nreads: [note]\n",
            "id: x\nversion: 1.0.0\ntitle: X\nwrites: [note@1]\n",
        ]
        .into_iter()
        .enumerate()
        {
            let (_d, b) = bundle(&format!("bad{i}"), bad, &[]);
            assert!(b.is_err(), "{bad}");
        }
    }

    #[test]
    fn a_required_backend_must_be_there_and_an_optional_one_may_be() {
        let (_a, b) = bundle("be1", &format!("{BASE}requires: [backend]\n"), &[("backend.py", "")]);
        assert!(b.unwrap().backend().is_some());
        let (_b, b) = bundle("be2", &format!("{BASE}requires: [backend]\n"), &[]);
        assert!(b.is_err());
        let (_c, b) = bundle("be3", BASE, &[("backend.py", "")]);
        assert!(b.unwrap().backend().is_some());
        let (_d, b) = bundle("be4", BASE, &[]);
        assert!(b.unwrap().backend().is_none());
    }

    #[test]
    fn gestalts_are_found_in_the_folder_and_defined_once() {
        let def = "name: thing\nversion: 1\n";
        let (_a, a) = bundle("g1", &format!("{BASE}reads: [thing@1]\n"), &[("gestalts/thing/v1.yml", def)]);
        let a = a.unwrap();
        assert!(gestalts_with(&[&a]).unwrap().get("thing@1").is_some());
        assert!(gestalts_with(&[&a, &a]).is_err());
        let (_b, b) = bundle("g2", &format!("{BASE}reads: [missing@1]\n"), &[]);
        assert!(gestalts_with(&[&b.unwrap()]).unwrap_err().contains("nothing defines"));
    }

    #[test]
    fn access_goes_by_the_gestalt_a_yml_names() {
        let g = Gestalts::builtin();
        let (_d, b) = bundle("acc", &format!("{BASE}reads: [note@1, concept@1]\nwrites: [note@1]\n"), &[]);
        let p = AccessPolicy::of(&b.unwrap().manifest);
        let note = "id: a\ngestalt: note@1\n";
        let concept = "id: a\ngestalt: concept@1\nname: x\n";
        assert!(p.can_read("a", note, &g) && p.can_write("a", note, &g));
        assert!(p.can_read("a", concept, &g) && !p.can_write("a", concept, &g));
        assert!(!p.can_read("a", "id: a\ngestalt: deck@1\nname: x\nmembers: []\n", &g));
        assert!(!p.can_write("a", "title: no gestalt\n", &g));
        assert!(!p.can_write("b", note, &g), "id mismatch");
    }
}
