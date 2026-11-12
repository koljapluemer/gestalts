//! Copies what the node needs of every plugin in the repo's `plugins/` (`plugin.yml`, `gestalts/`, `backend.py`: the
//! gestalts its ymls may use and the workers apps may call; views and decks are in the apps' own builds) to
//! `$OUT_DIR/plugins`, and the node's settings page (`../settings/dist`) to `$OUT_DIR/app`, which `include_dir!` embeds.
//!
//! No app is built in: apps are websites that use the node. Without the settings page built (`mise run
//! node:settings-build`) the node serves a page saying so; `mise run node:package` builds it first.

use std::fs;
use std::path::{Path, PathBuf};

const PLUGINS: &str = "../../../plugins";
const SETTINGS: &str = "../settings/dist";

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let (plugins_out, app_out) = (out.join("plugins"), out.join("app"));
    for dir in [&plugins_out, &app_out] {
        let _ = fs::remove_dir_all(dir);
        fs::create_dir_all(dir).unwrap();
    }

    let plugins = Path::new(PLUGINS);
    // include_dir! doesn't track changes by itself
    println!("cargo:rerun-if-changed={}", plugins.display());
    let mut found: Vec<PathBuf> = fs::read_dir(plugins).expect("the repo has plugins/").flatten().map(|e| e.path())
        .filter(|p| p.join("plugin.yml").is_file()).collect();
    found.sort();
    for src in found {
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

    let settings = Path::new(SETTINGS);
    println!("cargo:rerun-if-changed={}", settings.display());
    if settings.join("index.html").is_file() {
        copy_tree(settings, &app_out);
    } else {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            println!("cargo:warning=no settings page in {}: run `mise run node:settings-build`", settings.display());
        }
        fs::write(app_out.join("index.html"), "<!doctype html><meta charset=utf-8><title>gestalts-node</title>\
            <p>This build of gestalts-node has no settings page built in. Run <code>mise run node:settings-build</code>, \
            or use the dev server (<code>mise run node:dev</code>).</p>\n").unwrap();
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
