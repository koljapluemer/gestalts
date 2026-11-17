//! `plugin.yml`, and the bundle around it: pure, no IO beyond reading the bundle. Running backends is `plugins.rs`.
//!
//! A plugin is a folder: `plugin.yml`, `view.tsx`, and optionally `decks/<id>/` and `backend.py`. What it holds is
//! what's in the folder; the manifest only says what can't be seen there. Gestalts aren't a plugin's: they're the
//! core's or a model package's (`gestalts_fs::models`), so views and decks depend on models and not on each other.

use std::path::PathBuf;

use gestalts_core::{Gestalts, Yml, YmlState, valid_gestalt_id};
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
    /// what its frame asks to be allowed; the distribution decides what it gets
    #[serde(default)]
    pub permissions: Vec<Permission>,
    /// hosts its view may reach through the node's `/net`, exactly
    #[serde(default)]
    pub network: Vec<String>,
    /// its view asks for completions through the node's `/llm`
    #[serde(default)]
    pub llm: bool,
}

/// What a view's frame may be allowed beyond the strict sandbox. Only the distribution grants these.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    /// runs in the app's origin, so frames it embeds (a video player) work
    SameOrigin,
    /// records audio; needs `same-origin`, as a sandboxed frame isn't a secure context
    Microphone,
}

#[derive(Debug, Clone)]
pub struct PluginBundle {
    pub root: PathBuf,
    pub manifest: PluginManifest,
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
        if root.join("gestalts").exists() {
            return invalid(format!("{}: a plugin doesn't define gestalts; they go in a model package, gestalts/<package>/<name>/v<N>.yml", manifest.id));
        }
        Ok(Self { root, manifest })
    }

    /// Its `backend.py`, required or optional.
    pub fn backend(&self) -> Option<PathBuf> {
        Some(self.root.join("backend.py")).filter(|p| p.is_file())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn valid_version(v: &str) -> bool {
    let mut parts = v.split('.');
    parts.by_ref().take(3).count() == 3 && parts.next().is_none() && v.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
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
    if let Some(g) = m.reads.iter().chain(&m.writes).find(|g| !valid_gestalt_id(g)) {
        return invalid(format!("gestalt {g} is not name@N"));
    }
    if let Some(g) = m.writes.iter().find(|g| !m.reads.contains(g)) {
        return invalid(format!("{} writes {g} but doesn't read it", m.id));
    }
    if m.permissions.contains(&Permission::Microphone) && !m.permissions.contains(&Permission::SameOrigin) {
        return invalid(format!("{}: `microphone` needs `same-origin` too, as a sandboxed frame can't record", m.id));
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

/// The core's gestalts plus the model packages' (`models`, as YAML): each defined once, and every gestalt a plugin
/// reads existing.
pub fn gestalts_with(bundles: &[&PluginBundle], models: &[String]) -> Result<Gestalts, String> {
    let texts: Vec<&str> = models.iter().map(String::as_str).collect();
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
    fn permissions_network_and_llm_are_read_and_checked() {
        let (_d, b) = bundle("caps", &format!("{BASE}permissions: [same-origin, microphone]\nnetwork: [www.youtube.com]\nllm: true\n"), &[]);
        let m = b.unwrap().manifest;
        assert_eq!(m.permissions, vec![Permission::SameOrigin, Permission::Microphone]);
        for bad in ["[microphone]", "[camera]", "same-origin"] {
            let (_d, b) = bundle("perm-bad", &format!("{BASE}permissions: {bad}\n"), &[]);
            assert!(b.is_err(), "permissions: {bad} should be refused");
        }
        let (_d, b) = bundle("frame-gone", &format!("{BASE}frame: same-origin\n"), &[]);
        assert!(b.is_err(), "`frame` is no longer a key");
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
    fn gestalts_come_from_models_defined_once_and_never_from_plugins() {
        let def = "name: geo/thing\nversion: 1\n".to_owned();
        let (_a, a) = bundle("g1", &format!("{BASE}reads: [geo/thing@1]\n"), &[]);
        let a = a.unwrap();
        assert!(gestalts_with(&[&a], std::slice::from_ref(&def)).unwrap().get("geo/thing@1").is_some());
        assert!(gestalts_with(&[&a], &[def.clone(), def]).is_err());
        assert!(gestalts_with(&[&a], &[]).unwrap_err().contains("nothing defines"));
        let (_b, b) = bundle("g2", BASE, &[("gestalts/thing/v1.yml", "name: thing\nversion: 1\n")]);
        assert!(b.unwrap_err().to_string().contains("model package"));
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
