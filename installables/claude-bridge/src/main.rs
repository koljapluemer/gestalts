//! gestalts-claude-bridge: lets a website you allow run the claude CLI (Claude Code, signed in on this computer) with
//! the website's own tools. It knows nothing of what the site makes: the site sends the files, the instructions and
//! its tools; the bridge runs `claude -p` on them and relays every tool call back to the page.
//!
//! Started without a subcommand it lives in the tray; `serve` runs it headless; `mcp` is what claude starts during a
//! turn (the tools' MCP server).

use std::sync::Arc;

use clap::{Parser, Subcommand};

mod claude;
mod config;
mod mcp;
mod run;
mod server;
mod tray;

pub const NAME: &str = "gestalts-claude-bridge";
pub const TITLE: &str = "Claude bridge";
pub const ICON: &[u8] = include_bytes!("../assets/icon.png");
pub const PORT: u16 = 7737;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, global = true, default_value_t = PORT)]
    port: u16,
    /// keeps the allowed sites and workspaces apart, e.g. `--profile dev`
    #[arg(long, global = true)]
    profile: Option<String>,
    /// started on login: no dialogs unless something is wrong
    #[arg(long)]
    background: bool,
}

#[derive(Subcommand)]
enum Command {
    /// without the tray
    Serve {
        /// development: pages on localhost may use it without asking
        #[arg(long)]
        dev: bool,
    },
    /// the tools' MCP server, for claude during a turn (it sets the environment this needs)
    Mcp,
}

/// Headless: asks in a dialog where it can, from this thread.
struct DialogAsker;
impl server::Asker for DialogAsker {
    fn allow(&self, origin: &str) -> bool { tray::ask_allow(origin) }
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Some(Command::Mcp) => mcp::run(),
        Some(Command::Serve { dev }) => serve(cli.port, cli.profile.as_deref(), dev),
        None => tray::run(cli.port, cli.profile.as_deref(), cli.background),
    };
    if let Err(e) = result {
        eprintln!("{NAME}: {e}");
        std::process::exit(1);
    }
}

fn serve(port: u16, profile: Option<&str>, dev: bool) -> Result<(), String> {
    let paths = config::Paths::new(profile)?;
    let bridge = server::Bridge::new(paths, dev, Arc::new(DialogAsker))?;
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        println!("{NAME} on http://127.0.0.1:{port}{}", if dev { " (dev: localhost pages are allowed)" } else { "" });
        let c = bridge.claude().await;
        match (&c.path, &c.version) {
            (Some(p), Some(v)) => println!("claude: {v} ({})", p.display()),
            _ => println!("claude: not found; install Claude Code and sign in, or set GESTALTS_CLAUDE"),
        }
        server::serve(bridge, listener, stop_requested()).await
    })
}

/// Resolves on Ctrl+C, or on SIGTERM on Unix.
pub async fn stop_requested() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("can watch SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    { let _ = tokio::signal::ctrl_c().await; }
}
