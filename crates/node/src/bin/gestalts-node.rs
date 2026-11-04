//! The node headless: no tray, no built-in plugins (only `--plugins-dir`, else the user's `plugins/`).

use clap::Parser;
use gestalts_node::{Embedded, NodeCommand, Opts};

#[derive(Parser)]
#[command(version, about = "Serves a folder of Gestalts notes on 127.0.0.1 and hosts plugin workers")]
struct Cli {
    #[command(subcommand)]
    command: NodeCommand,
    #[command(flatten)]
    opts: Opts,
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = gestalts_node::run_command(cli.command, &cli.opts, Embedded::NONE) {
        eprintln!("gestalts-node: {e}");
        std::process::exit(1);
    }
}
