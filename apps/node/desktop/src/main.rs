//! gestalter, the gestalter's desktop app: the node (a folder on this computer as the source of truth, and the host of
//! the plugins' workers), which serves the gestalter itself on 127.0.0.1, with a tray icon, the gestalter's plugins
//! and its web build built in.
//!
//! Started without a subcommand it is the desktop app; `serve`, `lint` and `publish` are the node's own.

use clap::{Parser, Subcommand};
use gestalts_node::{Embedded, NodeCommand, Opts};
use include_dir::{Dir, include_dir};

mod tray;

pub const ICON: &[u8] = include_bytes!("../assets/icon.png");
pub const TITLE: &str = "gestalter";
/// `app` in the node's `/health`, so a second launch knows it found itself.
pub const NAME: &str = "gestalter";
/// The desktop app's earlier name: what an old install still answers `/health` with, and its autostart entry.
pub const OLD_NAME: &str = "gestalts-connector";
/// Other web frontends allowed to use the node, besides localhost.
pub const ORIGINS: &[&str] = &[
    // TODO: loops-for-learning's origin, once it is deployed
];

/// The plugins the gestalter ships, copied by `build.rs`.
static BUILTIN: Dir<'static> = include_dir!("$OUT_DIR/plugins");
/// The gestalter's web build, served at `/`.
static APP: Dir<'static> = include_dir!("$OUT_DIR/app");

pub const EMBEDDED: Embedded = Embedded { name: NAME, app: Some(&APP), builtin: Some(&BUILTIN), origins: ORIGINS };

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    opts: Opts,
    /// where "Open gestalter" goes instead of the node's own address (the Vite dev server, in development)
    #[arg(long, hide = true)]
    open_url: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    #[command(flatten)]
    Node(NodeCommand),
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        None => tray::run(&cli.opts, cli.open_url),
        Some(Command::Node(command)) => gestalts_node::run_command(command, &cli.opts, EMBEDDED),
    };
    if let Err(e) = result {
        eprintln!("gestalter: {e}");
        std::process::exit(1);
    }
}
