//! gestalts-claude-bridge: the web app's agents (the claude CLI, signed in on this computer) on 127.0.0.1. It is a
//! gestalts-node with the agent plugins (`plugins/`) and its own folder for the drafts the app syncs to it, apart
//! from folder-sync (`installables/folder-sync`): its own port, settings and data, no tray, no home network.
//!
//! Not packaged yet: it runs from a checkout, whose agent plugins, their templates (and the templates' dependencies)
//! and model packages it uses in place.

use std::path::PathBuf;

use clap::Parser;
use gestalts_node::{Embedded, Opts};

const NAME: &str = "gestalts-claude-bridge";
const CHECKOUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[arg(long, default_value_t = 7737)]
    port: u16,
    /// the drafts' folder (notes/ + blobs/); default: the bridge's own, in this user's app data
    #[arg(long)]
    data: Option<PathBuf>,
    /// keeps settings and drafts apart, e.g. `--profile dev`
    #[arg(long)]
    profile: Option<String>,
    /// web origins allowed to use it besides localhost (a deployed web app)
    #[arg(long)]
    allow_origin: Vec<String>,
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("{NAME}: {e}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let checkout = PathBuf::from(CHECKOUT);
    let profile = cli.profile.map_or_else(|| "claude-bridge".to_owned(), |p| format!("claude-bridge-{p}"));
    let data = match cli.data {
        Some(d) => d,
        None => gestalts_node::paths::Paths::new(Some(&profile))?.data.join("drafts"),
    };
    let opts = Opts {
        port: cli.port,
        plugins_dir: vec![checkout.join("installables/claude-bridge/plugins")],
        models_dir: vec![checkout.join("gestalts")],
        profile: Some(profile),
        allow_origin: cli.allow_origin,
        app_dir: None,
        // only listens while a device is paired, which the bridge has no page for
        lan_port: 0,
        background: false,
    };
    gestalts_node::serve(&opts, Embedded { name: NAME, ..Embedded::NONE }, Some(data))
}
