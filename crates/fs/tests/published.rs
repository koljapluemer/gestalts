//! Published definitions never change: `gestalts/published.yml` holds the structural hash
//! (`GestaltDef::structure_hash`) of every definition in the repo's `gestalts/`, the core's and the model packages'.
//! Descriptions may change; a structural change is a new version. `GESTALTS_PUBLISH=1` (`mise run gestalts:publish`)
//! adds definitions that aren't listed yet and never rewrites a listed one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gestalts_core::Gestalts;
use gestalts_fs::models::{is_package, read_models};

fn repo_gestalts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../gestalts")
}

/// The core's definitions: `gestalts/<name>/v<N>.yml`.
fn core_texts(root: &Path) -> Vec<String> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir() && !is_package(p)).collect();
    dirs.sort();
    let mut out = Vec::new();
    for d in dirs {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "yml")).collect();
        files.sort();
        out.extend(files.iter().map(|f| std::fs::read_to_string(f).unwrap()));
    }
    out
}

#[test]
fn published_definitions_never_change() {
    let root = repo_gestalts();
    let file = root.join("published.yml");
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let published: BTreeMap<String, String> = if text.trim().is_empty() { BTreeMap::new() } else { serde_yaml_ng::from_str(&text).expect("published.yml is a map of name@N to hash") };

    let core = core_texts(&root);
    let models = read_models(std::slice::from_ref(&root)).unwrap();
    let package_texts: Vec<&str> = models.iter().map(|m| m.text.as_str()).collect();
    // every definition loads, and none is defined twice
    let all = Gestalts::builtin_with(&package_texts).unwrap();
    assert_eq!(all.defs().len(), core.len() + models.len(), "a core definition in gestalts/ isn't compiled in");
    let in_package: BTreeMap<String, String> = models.iter().map(|m| {
        let def: gestalts_core::GestaltDef = serde_yaml_ng::from_str(&m.text).unwrap();
        (def.id(), m.package.clone())
    }).collect();

    let publish = std::env::var("GESTALTS_PUBLISH").is_ok_and(|v| v == "1");
    let mut problems = Vec::new();
    let mut added = Vec::new();
    for def in all.defs() {
        let (id, hash) = (def.id(), def.structure_hash());
        match published.get(&id) {
            Some(h) if *h == hash => {}
            Some(_) => problems.push(format!("{id}: a structural change to a published definition; make it {}@{} instead", def.name, def.version + 1)),
            None => match in_package.get(&id) {
                Some(package) if !def.name.contains('/') => problems.push(format!("{id}: a new gestalt in package `{package}` is named `{package}/{}`", def.name)),
                _ if publish => added.push((id, hash)),
                _ => problems.push(format!("{id} isn't in gestalts/published.yml: run `mise run gestalts:publish`")),
            },
        }
    }
    for id in published.keys().filter(|id| all.get(id).is_none()) {
        problems.push(format!("{id} is published, so its definition stays (ymls in learners' folders name it)"));
    }
    if !added.is_empty() && problems.is_empty() {
        let mut all_entries = published.clone();
        all_entries.extend(added.iter().cloned());
        let mut out = String::from("# The structural hash of every published definition in gestalts/: what makes a yml valid and how it merges.\n\
            # A listed definition never changes structurally (a change is a new version); descriptions may. Add new ones with\n\
            # `mise run gestalts:publish`. A line may be deleted by hand only for a definition that has never gone out.\n");
        for (id, hash) in &all_entries { out.push_str(&format!("{id}: {hash}\n")); }
        std::fs::write(&file, out).unwrap();
        added.iter().for_each(|(id, _)| eprintln!("published {id}"));
    }
    assert!(problems.is_empty(), "\n{}\n", problems.join("\n"));
}
