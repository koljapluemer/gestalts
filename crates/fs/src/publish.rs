//! Prepares a data folder for publishing as a read-only deck (served by `Static` in the browser).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use gestalts_core::{Gestalts, Yml, YmlState, blobs_of, content_hash};
use gestalts_core::storage::{Result, StorageError};
use serde::Serialize;

use crate::{FsStorage, io};

#[derive(Debug, Default, Serialize)]
pub struct PublishReport {
    /// `(old, new)` blob names
    pub renamed: Vec<(String, String)>,
    /// blobs no yml referenced, deleted
    pub removed: Vec<String>,
    /// ymls that can't be published as they are
    pub problems: Vec<String>,
}

/// Content-addressed name: the first 16 hex digits of the sha256, plus the old extension.
pub fn blob_name(bytes: &[u8], old: &str) -> String {
    let hash = &content_hash(bytes)[..16];
    match old.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => format!("{hash}.{}", ext.to_lowercase()),
        _ => hash.to_owned(),
    }
}

/// Renames blobs to their content hash and rewrites the ymls referring to them, deletes blobs no yml uses, and writes
/// `index.json`. Every yml must be valid by `gestalts`. Running it again changes nothing.
pub fn publish(root: &Path, gestalts: &Gestalts) -> Result<PublishReport> {
    let store = FsStorage::new(root);
    let mut report = PublishReport::default();

    let used = |id: &str, text: String| {
        let yml = Yml::parse(id, text);
        let state = gestalts.classify(&yml);
        let blobs = blobs_of(&yml, &state, gestalts);
        (state, blobs)
    };

    let ids = store.list_ymls_sync()?;
    let mut before = Vec::new();
    for id in &ids {
        before.extend(used(id, store.read_yml_sync(id)?.unwrap_or_default()).1);
    }

    let mut renames = BTreeMap::new();
    for name in store.list_blobs_sync()?.into_iter().filter(|n| before.contains(n)) {
        let bytes = store.read_blob_sync(&name)?.unwrap_or_default();
        let new = blob_name(&bytes, &name);
        if new != name {
            store.write_blob_sync(&new, &bytes)?;
            renames.insert(name.clone(), new.clone());
            report.renamed.push((name, new));
        }
    }

    let mut referenced = Vec::new();
    for id in &ids {
        let raw = store.read_yml_sync(id)?.unwrap_or_default();
        let mut text = raw.clone();
        for (old, new) in &renames {
            text = replace_name(&text, old, new);
        }
        if text != raw {
            store.write_yml_sync(id, &text)?;
        }
        let (state, blobs) = used(id, text);
        match state {
            YmlState::Valid(_) => {}
            YmlState::Tombstone => report.problems.push(format!("{id}: is deleted; a deck can't delete anything")),
            YmlState::Unknown(g) => report.problems.push(format!("{id}: no definition of {g}")),
            YmlState::Invalid(ps) => report.problems.extend(ps.iter().map(|p| format!("{id}: {} {}", p.path, p.message))),
        }
        for b in blobs {
            if store.read_blob_sync(&b)?.is_none() {
                report.problems.push(format!("{id}: blob {b} is missing"));
            }
            referenced.push(b);
        }
    }

    for name in store.list_blobs_sync()? {
        if !referenced.contains(&name) {
            fs::remove_file(root.join("blobs").join(&name)).map_err(io)?;
            if !renames.contains_key(&name) {
                report.removed.push(name);
            }
        }
    }

    #[derive(Serialize)]
    struct Index {
        ymls: Vec<String>,
        blobs: Vec<String>,
    }
    let index = Index { ymls: ids, blobs: store.list_blobs_sync()? };
    let json = serde_json::to_string_pretty(&index).map_err(|e| StorageError::Io(e.to_string()))? + "\n";
    crate::write_atomic(&root.join("index.json"), json.as_bytes())?;
    Ok(report)
}

/// Replaces whole occurrences of the file name `old`, not ones inside a longer name.
fn replace_name(text: &str, old: &str, new: &str) -> String {
    let part = |c: char| c.is_alphanumeric() || matches!(c, '.' | '-' | '_');
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(old) {
        let (before, after) = (&rest[..i], &rest[i + old.len()..]);
        let whole = !before.chars().next_back().is_some_and(part) && !after.chars().next().is_some_and(part);
        out.push_str(before);
        out.push_str(if whole { new } else { old });
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_addresses_blobs_idempotently() {
        let dir = std::env::temp_dir().join(format!("gestalts-publish-test-{}", std::process::id()));
        let s = FsStorage::new(&dir);
        s.write_yml_sync("c", "id: c\ngestalt: note@1\nblobs:\n- {label: audio, file: c.mp3}\n- {label: b, file: xc.mp3}\n").unwrap();
        s.write_blob_sync("c.mp3", &[1]).unwrap();
        s.write_blob_sync("xc.mp3", &[2]).unwrap();
        s.write_blob_sync("orphan.webp", &[3]).unwrap();

        let g = Gestalts::builtin();
        let r = publish(&dir, &g).unwrap();
        let (a, b) = (blob_name(&[1], "c.mp3"), blob_name(&[2], "xc.mp3"));
        assert_eq!(r.renamed.len(), 2);
        assert_eq!(r.removed, vec!["orphan.webp"]);
        assert!(r.problems.is_empty());
        assert_eq!(s.read_yml_sync("c").unwrap().unwrap(), format!("id: c\ngestalt: note@1\nblobs:\n- {{label: audio, file: {a}}}\n- {{label: b, file: {b}}}\n"));
        let mut blobs = vec![a, b];
        blobs.sort();
        assert_eq!(s.list_blobs_sync().unwrap(), blobs);
        let index = fs::read_to_string(dir.join("index.json")).unwrap();
        assert!(index.contains("\"c\"") && index.contains(&blobs[0]));

        let again = publish(&dir, &g).unwrap();
        assert!(again.renamed.is_empty() && again.removed.is_empty());
        assert_eq!(fs::read_to_string(dir.join("index.json")).unwrap(), index);
        fs::remove_dir_all(&dir).unwrap();
    }
}
