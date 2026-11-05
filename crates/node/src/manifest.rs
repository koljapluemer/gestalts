//! Domain contracts for plugins (`plugin.yml`, schema 2): pure, no IO beyond reading a bundle. Running workers is
//! `plugins.rs`.
//!
//! A plugin is a domain bundle: the gestalts it owns, its decks, optional UI (panes and slot views) and an
//! optional worker. See `doc/architecture.md#plugins`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use gestalts_core::{Gestalts, Note, Query};
use serde::{Deserialize, Serialize};

/// The version of the perspective port the apps offer (`HOST_API` in `@gestalts/sdk`).
pub const HOST_API: u32 = 2;

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub schema: u32,
    pub id: String,
    pub version: String,
    pub host_api: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// `name@N` of the gestalts this plugin owns, defined in `gestalts/<name>/v<N>.yml`
    #[serde(default)]
    pub gestalts: Vec<String>,
    /// `name@N` of gestalts owned elsewhere that it reads or writes: a data dependency
    #[serde(default)]
    pub uses: Vec<String>,
    /// starter content, one deck per topic; mounted under `<plugin id>/<deck id>`
    #[serde(default)]
    pub decks: Vec<DeckManifest>,
    #[serde(default)]
    pub panes: Vec<PaneManifest>,
    #[serde(default)]
    pub slots: Vec<SlotManifest>,
    /// how the host's note component shows and edits a gestalt's fields
    #[serde(default)]
    pub lenses: Vec<LensManifest>,
    /// what its UI may read and write
    #[serde(default)]
    pub access: UiAccess,
    #[serde(default)]
    pub worker: Option<WorkerManifest>,
}

/// Starter content in the published-deck format, mounted read-only under the user's folder. Decks that hold the same
/// key hold the same thing, and are merged when both are mounted.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeckManifest {
    pub id: String,
    pub title: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaneManifest {
    pub id: String,
    pub title: String,
    /// `<module path>#<export>`
    pub entry: String,
    /// what a host needs to run it; one that can't hides or greys the pane
    #[serde(default)]
    pub requires: PaneRequires,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PaneRequires {
    /// `name@N` of node services (a worker's `services`)
    pub services: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SlotManifest {
    pub slot: String,
    pub gestalt: String,
    pub entry: String,
}

/// A lens: a `defineLens` export (`@gestalts/sdk`) for one gestalt the plugin owns or uses.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LensManifest {
    pub gestalt: String,
    pub entry: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct UiAccess {
    pub read: Scope,
    pub write: Scope,
}

/// Which notes: `all`, or those with one of these gestalts (or all of these tags).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Scope {
    All(AllScope),
    Some {
        #[serde(default)]
        gestalts: Vec<String>,
        #[serde(default)]
        tags_all: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AllScope { All }

impl Default for Scope {
    fn default() -> Self { Scope::Some { gestalts: vec![], tags_all: vec![] } }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerManifest {
    pub runtime: Runtime,
    #[serde(default = "default_project")]
    pub project: PathBuf,
    pub command: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<Trigger>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub access: Access,
    #[serde(default)]
    pub network: Vec<String>,
}

fn default_project() -> PathBuf { PathBuf::from(".") }

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime { Uv, Binary, Container }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "on", rename_all = "lowercase", deny_unknown_fields)]
pub enum Trigger {
    Change { query: Query },
    Schedule { cron: String },
}

/// What a worker may do through the connector API.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Access {
    pub read: ReadAccess,
    pub write: WriteAccess,
    pub blobs: BlobAccess,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ReadAccess { pub gestalts: Vec<String>, pub tags_all: Vec<String> }

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WriteAccess { pub tags_all: Vec<String> }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct BlobAccess { pub read: BlobRead, pub write: bool }

impl Default for BlobAccess { fn default() -> Self { Self { read: BlobRead::None, write: false } } }

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlobRead { #[default] None, Referenced }

#[derive(Debug, Clone)]
pub struct PluginBundle { pub root: PathBuf, pub manifest: PluginManifest, gestalt_texts: Vec<String> }

impl PluginBundle {
    pub fn load(root: impl Into<PathBuf>) -> Result<Self, ManifestError> {
        let root = root.into();
        let path = root.join("plugin.yml");
        let text = std::fs::read_to_string(&path).map_err(|e| ManifestError::Read(path, e))?;
        let manifest: PluginManifest = serde_yaml_ng::from_str(&text)?;
        validate(&manifest)?;
        let mut gestalt_texts = Vec::new();
        for id in &manifest.gestalts {
            let file = gestalt_file(id).ok_or_else(|| ManifestError::Invalid(format!("gestalt {id} is not name@N")))?;
            let p = root.join(&file);
            gestalt_texts.push(std::fs::read_to_string(&p).map_err(|e| ManifestError::Read(p, e))?);
        }
        let defs = Gestalts::from_yaml(&gestalt_texts.iter().map(String::as_str).collect::<Vec<_>>()).map_err(ManifestError::Invalid)?;
        for (id, d) in manifest.gestalts.iter().zip(defs.defs()) {
            if &d.id() != id {
                return invalid(format!("gestalts/{}: defines {}, not {id}", gestalt_file(id).unwrap_or_default().display(), d.id()));
            }
        }
        Ok(Self { root, manifest, gestalt_texts })
    }

    /// The definitions of the gestalts this plugin owns, as YAML.
    pub fn gestalt_texts(&self) -> &[String] { &self.gestalt_texts }
}

/// `name@N` → `gestalts/<name>/v<N>.yml`
pub fn gestalt_file(id: &str) -> Option<PathBuf> {
    let (name, version) = id.split_once('@')?;
    version.parse::<u32>().ok()?;
    Some(PathBuf::from("gestalts").join(name).join(format!("v{version}.yml")))
}

fn safe_relative(path: &Path) -> Result<(), ManifestError> {
    if path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return invalid(format!("unsafe bundle path {}", path.display()));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'@' | b'.'))
}

fn valid_version(v: &str) -> bool {
    let mut parts = v.split('.');
    parts.by_ref().take(3).count() == 3 && parts.next().is_none() && v.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

fn valid_entry(entry: &str) -> Result<(), ManifestError> {
    let Some((module, export)) = entry.split_once('#') else { return invalid(format!("entry {entry} needs `<module>#<export>`")) };
    if export.is_empty() || !export.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return invalid(format!("invalid export in entry {entry}"));
    }
    safe_relative(Path::new(module))
}

fn valid_services(ids: &[String]) -> Result<(), ManifestError> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if !valid_id(id) || !id.contains('@') || !seen.insert(id) { return invalid(format!("invalid or duplicate service {id}")); }
    }
    Ok(())
}

fn validate(m: &PluginManifest) -> Result<(), ManifestError> {
    if m.schema != 2 { return invalid(format!("unsupported schema {}", m.schema)); }
    if !valid_id(&m.id) || m.id.contains('@') { return invalid(format!("invalid plugin id {}", m.id)); }
    if !valid_version(&m.version) { return invalid(format!("invalid version {}", m.version)); }
    if m.host_api != HOST_API { return invalid(format!("{} needs host API {}; this host offers {HOST_API}", m.id, m.host_api)); }
    for id in m.gestalts.iter().chain(&m.uses) {
        if gestalt_file(id).is_none() { return invalid(format!("gestalt {id} is not name@N")); }
    }
    let mut decks = BTreeSet::new();
    for d in &m.decks {
        if !valid_id(&d.id) || d.id.contains('@') || !decks.insert(&d.id) { return invalid(format!("invalid or duplicate deck {}", d.id)); }
        if d.title.trim().is_empty() { return invalid(format!("deck {} has no title", d.id)); }
        safe_relative(&d.path)?;
    }
    let mut panes = BTreeSet::new();
    for p in &m.panes {
        if !valid_id(&p.id) || p.id.contains('@') || !panes.insert(&p.id) { return invalid(format!("invalid or duplicate pane {}", p.id)); }
        valid_entry(&p.entry)?;
        valid_services(&p.requires.services)?;
    }
    for s in &m.slots {
        valid_entry(&s.entry)?;
        if gestalt_file(&s.gestalt).is_none() { return invalid(format!("slot gestalt {} is not name@N", s.gestalt)); }
    }
    let declared: BTreeSet<&String> = m.gestalts.iter().chain(&m.uses).collect();
    let mut lenses = BTreeSet::new();
    for l in &m.lenses {
        valid_entry(&l.entry)?;
        if !declared.contains(&l.gestalt) { return invalid(format!("lens for {}, which is neither in `gestalts` nor in `uses`", l.gestalt)); }
        if !lenses.insert(&l.gestalt) { return invalid(format!("more than one lens for {}", l.gestalt)); }
    }
    for scope in [&m.access.read, &m.access.write] {
        if let Scope::Some { gestalts, .. } = scope {
            for g in gestalts {
                if !declared.contains(g) { return invalid(format!("access names {g}, which is neither in `gestalts` nor in `uses`")); }
            }
        }
    }
    if let Some(w) = &m.worker {
        safe_relative(&w.project)?;
        if w.runtime != Runtime::Uv { return invalid("only the uv runtime is supported"); }
        if w.command.is_empty() || w.command.iter().any(String::is_empty) { return invalid("worker command is empty"); }
        valid_services(&w.services)?;
        for trigger in &w.triggers {
            if let Trigger::Schedule { cron } = trigger
                && cron.split_whitespace().count() != 5 { return invalid(format!("cron must have five fields: {cron}")); }
        }
    }
    Ok(())
}

/// The core's gestalts plus every plugin's, checking that each gestalt has exactly one owner and that every gestalt
/// a plugin uses exists.
pub fn gestalts_with(bundles: &[&PluginBundle]) -> Result<Gestalts, String> {
    let core = Gestalts::builtin();
    let mut owner: BTreeMap<String, String> = core.defs().iter().map(|d| (d.id(), "the core".to_owned())).collect();
    let mut texts: Vec<&str> = Vec::new();
    for b in bundles {
        for id in &b.manifest.gestalts {
            if let Some(o) = owner.insert(id.clone(), b.manifest.id.clone()) {
                return Err(format!("{id} is owned by both {o} and {}", b.manifest.id));
            }
        }
        texts.extend(b.gestalt_texts().iter().map(String::as_str));
    }
    for b in bundles {
        for id in &b.manifest.uses {
            if !owner.contains_key(id) { return Err(format!("{} uses {id}, which nothing defines", b.manifest.id)); }
        }
    }
    Gestalts::builtin_with(&texts)
}

/// Capability checks are pure domain policy and shared by every HTTP/storage adapter.
#[derive(Debug, Clone)]
pub struct AccessPolicy { pub access: Access, pub gestalt_ids: BTreeMap<String, Vec<String>> }

impl AccessPolicy {
    pub fn can_read(&self, note: &Note) -> bool {
        let gs = self.gestalt_ids.get(&note.key).map(Vec::as_slice).unwrap_or_default();
        self.access.read.gestalts.iter().any(|g| gs.contains(g)) && self.access.read.tags_all.iter().all(|t| note.has_tag(t))
    }
    pub fn can_write(&self, note: &Note) -> bool {
        note.parse_error.is_none() && !self.access.write.tags_all.is_empty() && self.access.write.tags_all.iter().all(|t| note.has_tag(t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_escape() { assert!(safe_relative(Path::new("../worker")).is_err()); }
    #[test]
    fn validates_semver() { assert!(valid_version("1.2.0")); assert!(!valid_version("1.2")); }
    #[test]
    fn access_policy_requires_declared_shapes_and_owned_tags() {
        let access = Access { read: ReadAccess { gestalts: vec!["flashcard@1".into()], tags_all: vec![] },
            write: WriteAccess { tags_all: vec!["owned".into()] }, blobs: BlobAccess::default() };
        let mut gestalt_ids = BTreeMap::new(); gestalt_ids.insert("a".into(), vec!["flashcard@1".into()]);
        let policy = AccessPolicy { access, gestalt_ids };
        assert!(policy.can_read(&Note::parse("a", "tags: [flashcard]")));
        assert!(policy.can_write(&Note::parse("x", "tags: [owned]")));
        assert!(!policy.can_write(&Note::parse("x", "tags: [other]")));
    }

    /// Every plugin in the repo loads, and together with the core they define each gestalt once.
    #[test]
    fn repo_plugins_are_valid() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins");
        let mut bundles = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            if entry.path().join("plugin.yml").is_file() {
                bundles.push(PluginBundle::load(entry.path()).unwrap_or_else(|e| panic!("{}: {e}", entry.path().display())));
            }
        }
        assert!(bundles.len() >= 2);
        let g = gestalts_with(&bundles.iter().collect::<Vec<_>>()).unwrap();
        assert!(g.get("quote@1").is_some());
        assert!(g.get("fsrs-state@1").is_some());
    }

    #[test]
    fn decks_have_unique_ids_titles_and_safe_paths() {
        let load = |decks: &str| {
            let dir = std::env::temp_dir().join(format!("gestalts-plugin-decks-{}-{}", std::process::id(), decks.len()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("plugin.yml"), format!("schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\ndecks: {decks}\n")).unwrap();
            let r = PluginBundle::load(&dir).map(|b| b.manifest.decks.len());
            std::fs::remove_dir_all(&dir).unwrap();
            r
        };
        assert_eq!(load("[{id: world, title: World, path: decks/world}, {id: africa, title: Africa, path: decks/africa}]").unwrap(), 2);
        assert!(load("[{id: a, title: A, path: d/a}, {id: a, title: B, path: d/b}]").is_err());
        assert!(load("[{id: a, title: A, path: ../a}]").is_err());
        assert!(load("[{id: Africa, title: A, path: d/a}]").is_err());
        assert!(load("[{id: a, title: ' ', path: d/a}]").is_err());
        assert!(load("[{id: a, title: A, path: d/a, aliases: [b]}]").is_err());
    }

    #[test]
    fn lenses_are_for_gestalts_the_plugin_owns_or_uses() {
        let load = |lenses: &str| {
            let dir = std::env::temp_dir().join(format!("gestalts-plugin-lenses-{}-{}", std::process::id(), lenses.len()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("plugin.yml"), format!("schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\nuses: [appointment@1]\nlenses: {lenses}\n")).unwrap();
            let r = PluginBundle::load(&dir).map(|b| b.manifest.lenses.len());
            std::fs::remove_dir_all(&dir).unwrap();
            r
        };
        assert_eq!(load("[{gestalt: appointment@1, entry: ui/a.ts#A}]").unwrap(), 1);
        assert!(load("[{gestalt: quote@1, entry: ui/a.ts#Q}]").is_err());
        assert!(load("[{gestalt: appointment@1, entry: ui/a.ts#A}, {gestalt: appointment@1, entry: ui/a.ts#B}]").is_err());
        assert!(load("[{gestalt: appointment@1, entry: ../a.ts#A}]").is_err());
    }

    #[test]
    fn a_gestalt_has_one_owner() {
        let dir = std::env::temp_dir().join(format!("gestalts-plugin-owner-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("gestalts/flashcard")).unwrap();
        std::fs::write(dir.join("plugin.yml"), "schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\ngestalts: [flashcard@1]\n").unwrap();
        std::fs::write(dir.join("gestalts/flashcard/v1.yml"), "name: flashcard\nversion: 1\n").unwrap();
        let b = PluginBundle::load(&dir).unwrap();
        assert!(gestalts_with(&[&b]).unwrap_err().contains("owned by both"));
        std::fs::write(dir.join("plugin.yml"), "schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\nuses: [nothing@1]\n").unwrap();
        assert!(gestalts_with(&[&PluginBundle::load(&dir).unwrap()]).unwrap_err().contains("nothing defines"));
        std::fs::write(dir.join("plugin.yml"), "schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\naccess: {read: {gestalts: [term@1]}}\n").unwrap();
        assert!(PluginBundle::load(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn panes_require_services() {
        let dir = std::env::temp_dir().join(format!("gestalts-plugin-requires-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = |services: &str| format!("schema: 2\nid: x\nversion: 1.0.0\nhost_api: 2\npanes:\n  - {{ id: p, title: P, entry: ui/a.ts#P, requires: {{ services: {services} }} }}\n");
        std::fs::write(dir.join("plugin.yml"), manifest("[typst@1]")).unwrap();
        assert_eq!(PluginBundle::load(&dir).unwrap().manifest.panes[0].requires.services, ["typst@1"]);
        for bad in ["[typst]", "[typst@1, typst@1]", "[Typst@1]"] {
            std::fs::write(dir.join("plugin.yml"), manifest(bad)).unwrap();
            assert!(PluginBundle::load(&dir).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
