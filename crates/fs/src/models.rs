//! Model packages: the gestalts that aren't the core's, loaded at runtime. In the repo's `gestalts/`, a folder holding
//! `v<N>.yml` is one of the core's (compiled in); a folder holding gestalt folders is a package,
//! `gestalts/<package>/<name>/v<N>.yml`. A package's gestalts are named `<package>/<name>`, except those published
//! before packages existed, which keep their flat `<name>` (`gestalts/published.yml`).

use std::path::{Path, PathBuf};

/// One definition of a model package.
#[derive(Debug, Clone)]
pub struct ModelFile {
    pub package: String,
    pub path: PathBuf,
    pub text: String,
}

fn dirs(p: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    let mut out: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    out.sort();
    Ok(out)
}

fn definitions(p: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    let mut out: Vec<PathBuf> = entries.flatten().map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "yml") && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('v')))
        .collect();
    out.sort();
    Ok(out)
}

/// Whether `dir` is a model package rather than one of the core's gestalts.
pub fn is_package(dir: &Path) -> bool {
    dir.is_dir() && definitions(dir).is_ok_and(|d| d.is_empty()) && dirs(dir).is_ok_and(|d| d.iter().any(|g| definitions(g).is_ok_and(|d| !d.is_empty())))
}

/// The definitions of one package, in a stable order. Each must be in the folder named after it.
pub fn read_package(dir: &Path) -> Result<Vec<ModelFile>, String> {
    let package = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = Vec::new();
    for gestalt in dirs(dir)? {
        let folder = gestalt.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for path in definitions(&gestalt)? {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let def: gestalts_core::GestaltDef = serde_yaml_ng::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            if def.name.rsplit('/').next() != Some(folder.as_str()) {
                return Err(format!("{}: `{}` belongs in a folder named after it", path.display(), def.name));
            }
            if let Some((ns, _)) = def.name.split_once('/') && ns != package {
                return Err(format!("{}: `{}` is in package `{package}`", path.display(), def.name));
            }
            out.push(ModelFile { package: package.clone(), path, text });
        }
    }
    Ok(out)
}

/// Every package's definitions in each of `roots`, folders of packages (like the repo's `gestalts/`, whose core
/// folders are skipped).
pub fn read_models(roots: &[PathBuf]) -> Result<Vec<ModelFile>, String> {
    let mut out = Vec::new();
    for root in roots.iter().filter(|d| d.is_dir()) {
        for dir in dirs(root)?.into_iter().filter(|d| is_package(d)) {
            out.extend(read_package(&dir)?);
        }
    }
    Ok(out)
}
