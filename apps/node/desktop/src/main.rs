//! gestalts-node on the desktop: a folder on this computer as the source of truth for the gestalts apps (websites
//! that use it on 127.0.0.1), the host of the plugins' workers, with a tray icon and its own settings page.
//!
//! Started without a subcommand it is the desktop app; `serve` runs it headless, `health` and `publish` check and
//! prepare a folder.

use clap::{Parser, Subcommand};
use gestalts_node::{Embedded, NodeCommand, Opts};
use include_dir::{Dir, include_dir};

mod tray;

pub const ICON: &[u8] = include_bytes!("../assets/icon.png");
pub const TITLE: &str = "gestalts-node";
/// `app` in the node's `/health`, so a second launch knows it found itself.
pub const NAME: &str = "gestalts-node";
/// The desktop app's earlier names, newest first: what an old install still answers `/health` with, and its
/// autostart entry.
pub const OLD_NAMES: &[&str] = &["gestalter", "gestalts-connector"];
/// The apps (websites) allowed to use the node, besides localhost.
pub const ORIGINS: &[&str] = &["https://gestalter.koljasam.com", "https://loop.koljasam.com"];

/// The repo's plugins (their gestalts and workers), copied by `build.rs`.
static BUILTIN: Dir<'static> = include_dir!("$OUT_DIR/plugins");
/// The node's settings page, served at `/`.
static APP: Dir<'static> = include_dir!("$OUT_DIR/app");

pub const EMBEDDED: Embedded = Embedded { name: NAME, app: Some(&APP), builtin: Some(&BUILTIN), origins: ORIGINS };

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    opts: Opts,
    /// where "Open settings" goes instead of the node's own address (the Vite dev server, in development)
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
        eprintln!("gestalts-node: {e}");
        std::process::exit(1);
    }
}
