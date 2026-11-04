//! gestalts-node: serves a folder on this computer to the Gestalts apps over HTTP on 127.0.0.1, and hosts plugin
//! workers. Apps embed it (the Gestalter's desktop app adds a tray and its built-in plugins); `gestalts-node` is the
//! same server headless.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Subcommand;
use gestalts_fs::FsStorage;

pub mod paths;
pub mod plugins;
pub mod server;
pub mod uv;

use paths::{Config, Paths};
use plugins::PluginHost;
use server::{AppState, Folder, UiRequest};

#[derive(clap::Args, Clone, Debug)]
pub struct Opts {
    #[arg(long, global = true, default_value_t = 7717)]
    pub port: u16,
    /// plugin folders to use instead of the built-in plugins (for developing plugins)
    #[arg(long, global = true)]
    pub plugins_dir: Vec<PathBuf>,
    /// keeps settings separate from the installed app, e.g. `--profile dev`
    #[arg(long, global = true)]
    pub profile: Option<String>,
    /// extra web origins allowed to connect (besides localhost and the app's own frontends)
    #[arg(long, global = true)]
    pub allow_origin: Vec<String>,
    /// desktop app: start in the tray without opening the window (used by "Start on login")
    #[arg(long)]
    pub background: bool,
}

/// What an app brings along: plugins compiled into its binary, and the web origins of its own frontends.
#[derive(Clone, Copy)]
pub struct Embedded {
    /// the plugins (manifests, gestalts, workers; one folder each) and the Python SDK their workers depend on by
    /// relative path (`../../../sdk/python`), unpacked in that layout
    pub builtin: Option<(&'static include_dir::Dir<'static>, &'static include_dir::Dir<'static>)>,
    pub origins: &'static [&'static str],
}

impl Embedded {
    pub const NONE: Embedded = Embedded { builtin: None, origins: &[] };
}

/// The subcommands every node binary has.
#[derive(Subcommand, Clone, Debug)]
pub enum NodeCommand {
    /// run without tray or window; the folder comes from --data or the remembered choice
    Serve {
        /// the data folder (notes/ + blobs/); created if missing; not remembered
        #[arg(long)]
        data: Option<PathBuf>,
    },
    /// print each note's gestalts and lints; exits non-zero on lints
    Lint { dir: PathBuf },
    /// prepare a folder as a published deck (content-addressed blobs, unreferenced ones deleted,
    /// index.json), then lint; exits non-zero on problems
    Publish { dir: PathBuf },
}

pub fn run_command(command: NodeCommand, opts: &Opts, embedded: Embedded) -> Result<(), String> {
    match command {
        NodeCommand::Serve { data } => serve(opts, embedded, data),
        NodeCommand::Lint { dir } => all_gestalts(opts, embedded).map(|g| std::process::exit(i32::from(lint(&FsStorage::new(&dir), &g) > 0))),
        NodeCommand::Publish { dir } => all_gestalts(opts, embedded).map(|g| std::process::exit(i32::from(publish(&dir, &g) > 0))),
    }
}

/// A running server: its own tokio runtime, so a desktop UI can own the main thread.
pub struct Server {
    rt: tokio::runtime::Runtime,
    plugins: PluginHost,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    pub paths: Paths,
    pub control_token: String,
}

impl Server {
    /// Stops serving and stops every plugin worker.
    pub fn stop(self) {
        let _ = self.shutdown.send(());
        let (plugins, task) = (self.plugins, self.task);
        self.rt.block_on(async move {
            plugins.stop_all().await;
            let _ = task.await;
        });
    }

    pub fn block_on<F: std::future::Future>(&self, f: F) -> F::Output { self.rt.block_on(f) }

    pub fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(&self, f: F) { self.rt.spawn(f); }
}

/// Starts the server and the plugins. `remember` saves folders chosen later in the app's config.
pub fn start_server(opts: &Opts, embedded: Embedded, paths: Paths, folder: Option<Folder>, remember: bool,
                    ui: Arc<dyn Fn(UiRequest) + Send + Sync>) -> Result<Server, String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let control_token = uuid::Uuid::new_v4().to_string();
    paths::write_secret(&paths.control_token_file(), &control_token).map_err(|e| format!("cannot write the control token: {e}"))?;
    let plugin_dirs = plugin_dirs(opts, embedded, &paths)?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], opts.port));
    let listener = rt.block_on(tokio::net::TcpListener::bind(addr)).map_err(|e| format!("cannot listen on {addr}: {e}"))?;
    let address = format!("http://{addr}");
    let plugins = PluginHost::discover(&plugin_dirs, address.clone(), paths.clone())?;
    let mut origins: Vec<String> = embedded.origins.iter().map(|o| o.to_string()).collect();
    origins.extend(Config::load(&paths).extra_origins);
    origins.extend(opts.allow_origin.iter().cloned());
    let state = AppState::new(folder, plugins.clone(), control_token.clone(), remember.then(|| paths.clone()), ui, address, origins);
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let starting = plugins.clone();
    rt.spawn(async move { starting.start_all().await });
    let task = rt.spawn(async move {
        let served = axum::serve(listener, server::app(state)).with_graceful_shutdown(async { let _ = stopped.await; }).await;
        if let Err(e) = served { eprintln!("gestalts-node: server stopped: {e}"); }
    });
    Ok(Server { rt, plugins, shutdown, task, paths, control_token })
}

/// Where plugins come from: `--plugins-dir`, else the app's built-in ones (unpacked) and the user's.
fn plugin_dirs(opts: &Opts, embedded: Embedded, paths: &Paths) -> Result<Vec<PathBuf>, String> {
    if !opts.plugins_dir.is_empty() {
        return Ok(opts.plugins_dir.clone());
    }
    let mut dirs = Vec::new();
    if let Some((builtin, sdk)) = embedded.builtin {
        dirs.push(plugins::unpack_builtin(paths, builtin, sdk).map_err(|e| format!("cannot unpack the built-in plugins: {e}"))?);
    }
    dirs.push(paths.user_plugins());
    Ok(dirs)
}

/// The core's gestalts and those of every plugin `opts` finds, for `lint` and `publish`.
fn all_gestalts(opts: &Opts, embedded: Embedded) -> Result<gestalts_core::Gestalts, String> {
    let paths = Paths::new(opts.profile.as_deref())?;
    plugins::load_gestalts(&plugin_dirs(opts, embedded, &paths)?)
}

/// Resolves on Ctrl+C, or on SIGTERM (`kill`, logout, service managers) on Unix.
pub async fn stop_requested() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("can watch SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    { let _ = tokio::signal::ctrl_c().await; }
}

/// The remembered folder, if it still exists.
pub fn remembered_folder(paths: &Paths) -> Option<Folder> {
    let path = Config::load(paths).folder?;
    match Folder::open(&path) {
        Ok(f) => Some(f),
        Err(e) => { eprintln!("gestalts-node: not reopening {}: {e}", path.display()); None }
    }
}

/// Serves headless until Ctrl+C or SIGTERM.
pub fn serve(opts: &Opts, embedded: Embedded, data: Option<PathBuf>) -> Result<(), String> {
    let paths = Paths::new(opts.profile.as_deref())?;
    let (folder, remember) = match &data {
        Some(dir) => (Some(Folder::open(dir)?), false),
        None => (remembered_folder(&paths), true),
    };
    match &folder {
        Some(f) => println!("gestalts-node serving {} on http://127.0.0.1:{}", f.info().path, opts.port),
        None => println!("gestalts-node on http://127.0.0.1:{} (no folder yet: pass --data or choose one in the desktop app)", opts.port),
    }
    let server = start_server(opts, embedded, paths, folder, remember, Arc::new(|_| {}))?;
    server.block_on(stop_requested());
    server.stop();
    Ok(())
}

/// Prints `key: gestalts` per note and any lints; returns the number of lints.
fn lint(store: &FsStorage, gestalts: &gestalts_core::Gestalts) -> usize {
    let mut count = 0;
    for key in store.list_notes_sync().expect("can list notes") {
        let raw = store.read_note_sync(&key).ok().flatten().unwrap_or_default();
        if gestalts_core::is_tombstone_text(&raw) {
            continue;
        }
        let note = gestalts_core::Note::parse(key.clone(), raw);
        println!("{key}: {}", gestalts.of(&note).join(", "));
        if let Some(e) = &note.parse_error {
            println!("  ! {}", e.message);
            count += 1;
        }
        for l in gestalts.lint(&note) {
            println!("  ! {} {}: {}", l.gestalt, l.path, l.message);
            count += 1;
        }
    }
    eprintln!("{count} problem(s)");
    count
}

fn publish(dir: &std::path::Path, gestalts: &gestalts_core::Gestalts) -> usize {
    let r = gestalts_fs::publish(dir).expect("can publish the folder");
    r.renamed.iter().for_each(|(a, b)| println!("renamed {a} -> {b}"));
    r.removed.iter().for_each(|b| println!("removed unreferenced {b}"));
    r.problems.iter().for_each(|p| println!("! {p}"));
    r.problems.len() + lint(&FsStorage::new(dir), gestalts)
}
