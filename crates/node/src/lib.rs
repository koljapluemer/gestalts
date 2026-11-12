//! gestalts-node: serves a folder on this computer to the gestalts apps over HTTP on 127.0.0.1, and hosts plugin
//! workers. The desktop app (`apps/node/desktop`) embeds it with a tray, the repo's plugins and the node's settings
//! page, which the node serves at `/`; its `serve` subcommand is the same server headless.

use std::path::PathBuf;
use std::sync::Arc;

use clap::Subcommand;
use gestalts_fs::FsStorage;

pub mod lan;
pub mod llm;
pub mod manifest;
pub mod net;
pub mod pairing;
pub mod paths;
pub mod plugins;
pub mod server;
pub mod uv;
pub mod watch;

use paths::{Config, Paths};
use plugins::PluginHost;
use server::{AppFiles, AppState, Folder, Identity, Shell};

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
    /// a web app's build (e.g. `dist/`) to serve at `/`, instead of the app's own
    #[arg(long, global = true)]
    pub app_dir: Option<PathBuf>,
    /// the port paired devices reach this node on over the home network (only while one is paired or pairing)
    #[arg(long, global = true, default_value_t = lan::LAN_PORT)]
    pub lan_port: u16,
    /// desktop app: start in the tray without opening the window (used by "Start on login")
    #[arg(long)]
    pub background: bool,
}

/// What the binary brings along: its name, plugins and settings page compiled in, and the web origins of the apps
/// allowed to use it.
#[derive(Clone, Copy)]
pub struct Embedded {
    /// reported as `app` in `/health`
    pub name: &'static str,
    /// the node's own page (a static build) served at `/`
    pub app: Option<&'static include_dir::Dir<'static>>,
    /// the plugins, one folder each
    pub builtin: Option<&'static include_dir::Dir<'static>>,
    pub origins: &'static [&'static str],
}

impl Embedded {
    pub const NONE: Embedded = Embedded { name: "gestalts-node", app: None, builtin: None, origins: &[] };
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
    /// print every yml that can't be used and why; exits non-zero if there is one
    Health { dir: PathBuf },
    /// prepare a folder as a published deck (content-addressed blobs, unreferenced ones deleted,
    /// index.json), then check it; exits non-zero on problems
    Publish { dir: PathBuf },
}

pub fn run_command(command: NodeCommand, opts: &Opts, embedded: Embedded) -> Result<(), String> {
    match command {
        NodeCommand::Serve { data } => serve(opts, embedded, data),
        NodeCommand::Health { dir } => all_gestalts(opts, embedded).map(|g| std::process::exit(i32::from(health(&FsStorage::new(&dir), &g) > 0))),
        NodeCommand::Publish { dir } => all_gestalts(opts, embedded).map(|g| std::process::exit(i32::from(publish(&dir, &g) > 0))),
    }
}

/// A running server: its own tokio runtime, so a desktop UI can own the main thread.
pub struct Server {
    rt: tokio::runtime::Runtime,
    plugins: PluginHost,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    lan: Arc<lan::Lan>,
    pub paths: Paths,
    pub control_token: String,
    /// `http://127.0.0.1:<port>`, also where the app's web frontend is
    pub address: String,
}

impl Server {
    /// Stops serving and stops every plugin worker.
    pub fn stop(self) {
        let _ = self.shutdown.send(());
        self.lan.shutdown();
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
                    shell: Arc<dyn Shell>) -> Result<Server, String> {
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
    let app = opts.app_dir.clone().map(AppFiles::Disk).or(embedded.app.map(AppFiles::Embedded));
    let identity = Identity { name: embedded.name, app };
    let lan = Arc::new(lan::Lan::new(&paths, opts.lan_port)?);
    let state = AppState::new(folder, plugins.clone(), control_token.clone(), remember.then(|| paths.clone()), shell, identity, address.clone(), origins)
        .with_lan(lan.clone());
    // devices paired earlier reach it from the start
    if let Err(e) = rt.block_on(async { lan.update(&state) }) { eprintln!("gestalts-node: {e}"); }
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let starting = plugins.clone();
    rt.spawn(async move { starting.start_all().await });
    let task = rt.spawn(async move {
        let served = axum::serve(listener, server::app(state)).with_graceful_shutdown(async { let _ = stopped.await; }).await;
        if let Err(e) = served { eprintln!("gestalts-node: server stopped: {e}"); }
    });
    Ok(Server { rt, plugins, shutdown, task, lan, paths, control_token, address })
}

/// Where plugins come from: `--plugins-dir`, else the app's built-in ones (unpacked) and the user's.
fn plugin_dirs(opts: &Opts, embedded: Embedded, paths: &Paths) -> Result<Vec<PathBuf>, String> {
    if !opts.plugins_dir.is_empty() {
        return Ok(opts.plugins_dir.clone());
    }
    let mut dirs = Vec::new();
    if let Some(builtin) = embedded.builtin {
        dirs.push(plugins::unpack_builtin(paths, builtin).map_err(|e| format!("cannot unpack the built-in plugins: {e}"))?);
    }
    dirs.push(paths.user_plugins());
    Ok(dirs)
}

/// The core's gestalts and those of every plugin `opts` finds, for `health` and `publish`.
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
    let server = start_server(opts, embedded, paths, folder, remember, Arc::new(server::Headless))?;
    server.block_on(stop_requested());
    server.stop();
    Ok(())
}

/// Prints every yml that can't be used; returns how many there are.
fn health(store: &FsStorage, gestalts: &gestalts_core::Gestalts) -> usize {
    let mut count = 0;
    for id in store.list_ymls_sync().expect("can list ymls") {
        let yml = gestalts_core::Yml::parse(id.clone(), store.read_yml_sync(&id).ok().flatten().unwrap_or_default());
        if let gestalts_core::YmlState::Invalid(problems) = gestalts.classify(&yml) {
            count += 1;
            println!("{id}");
            problems.iter().for_each(|p| println!("  ! {} {}", p.path, p.message));
        }
    }
    eprintln!("{count} invalid yml(s)");
    count
}

fn publish(dir: &std::path::Path, gestalts: &gestalts_core::Gestalts) -> usize {
    let r = gestalts_fs::publish(dir, gestalts).expect("can publish the folder");
    r.renamed.iter().for_each(|(a, b)| println!("renamed {a} -> {b}"));
    r.removed.iter().for_each(|b| println!("removed unreferenced {b}"));
    r.problems.iter().for_each(|p| println!("! {p}"));
    r.problems.len()
}
