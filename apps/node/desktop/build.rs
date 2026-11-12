//! Copies what the node needs of the plugins `distribution.yml` lists (`plugin.yml`, `gestalts/`, `backend.py`; a
//! plugin's view and decks are in the web build) to `$OUT_DIR/plugins`, and the web app's build (`distribution/dist`) to
//! `$OUT_DIR/app`, which `include_dir!` embeds.
//!
//! A release build needs the web app built (`mise run build`); a debug build without it serves a page saying so (in
//! development the gestalter comes from Vite anyway).

use std::fs;
use std::path::{Path, PathBuf};

/// The web app whose plugins the desktop app ships.
const APP: &str = "../../gestalter/distribution";

#[derive(serde::Deserialize)]
struct Distribution {
    #[serde(default)]
    core: Vec<String>,
    #[serde(default)]
    plugins: Vec<String>,
}

fn main() {
    let app = Path::new(APP);
    let manifest = app.join("distribution.yml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let d: Distribution = serde_yaml_ng::from_str(&fs::read_to_string(&manifest).expect("the web app has a distribution.yml")).expect("distribution.yml is valid");

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let (plugins_out, app_out) = (out.join("plugins"), out.join("app"));
    for dir in [&plugins_out, &app_out] {
        let _ = fs::remove_dir_all(dir);
        fs::create_dir_all(dir).unwrap();
    }
    for path in d.core.iter().chain(&d.plugins) {
        let src = fs::canonicalize(app.join(path)).unwrap_or_else(|_| panic!("{path} is missing"));
        assert!(src.join("plugin.yml").is_file(), "{} has no plugin.yml", src.display());
        // include_dir! doesn't track changes by itself
        println!("cargo:rerun-if-changed={}", src.display());
        let dest = plugins_out.join(src.file_name().unwrap());
        fs::create_dir_all(&dest).unwrap();
        fs::copy(src.join("plugin.yml"), dest.join("plugin.yml")).unwrap();
        if src.join("gestalts").is_dir() {
            copy_tree(&src.join("gestalts"), &dest.join("gestalts"));
        }
        if src.join("backend.py").is_file() {
            fs::copy(src.join("backend.py"), dest.join("backend.py")).unwrap();
        }
    }

    let dist = app.join("dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if dist.join("index.html").is_file() {
        copy_tree(&dist, &app_out);
    } else if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!("{} is missing; run `mise run build` first", dist.join("index.html").display());
    } else {
        fs::write(app_out.join("index.html"), "<!doctype html><meta charset=utf-8><title>gestalter</title>\
            <p>This debug build has no gestalter built in. Run <code>mise run build</code>, or use the dev server \
            (<code>mise run dev</code>).</p>\n").unwrap();
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.starts_with('.') || name_s == "__pycache__" || name_s == "node_modules" {
            continue;
        }
        let ty = entry.file_type().unwrap();
        if ty.is_dir() {
            copy_tree(&entry.path(), &to.join(&name));
        } else if ty.is_file() {
            fs::copy(entry.path(), to.join(&name)).unwrap();
        }
    }
}
