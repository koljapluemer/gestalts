//! The tray: one desktop app per user, shown as a tray icon. It runs the node, which serves the gestalter on
//! 127.0.0.1, and opens that in the default browser. The gestalter's Desktop settings use what this app can do (the
//! folder picker, the file manager, start on login) through the node's `Shell`.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use gestalts_node::paths::Paths;
use gestalts_node::server::{CONTROL_HEADER, FolderInfo, Shell};
use gestalts_node::{Opts, Server};

use crate::{EMBEDDED, ICON, NAME, OLD_NAME, TITLE};

pub enum Msg {
    Show,
    Quit,
    FolderChanged(Option<FolderInfo>),
    /// show the folder picker (on the main thread, which macOS and Windows need) and answer with the choice
    PickFolder(mpsc::Sender<Option<PathBuf>>),
    Menu(MenuId),
}

type Sender = Arc<dyn Fn(Msg) + Send + Sync>;

pub fn run(opts: &Opts, open_url: Option<String>) -> Result<(), String> {
    let result = (|| {
        let paths = Paths::new(opts.profile.as_deref())?;
        if hand_over_to_running(opts, &paths)? { return Ok(()); }
        platform::run(opts.clone(), paths, open_url)
    })();
    // launched from the app menu, nobody sees stderr
    if let Err(e) = &result { error_dialog(e); }
    result
}

fn error_dialog(message: &str) {
    let _ = rfd::MessageDialog::new().set_title(TITLE).set_description(message).set_level(rfd::MessageLevel::Error).show();
}

/// If we already run on the port, ask that instance to open the gestalter and report `true`.
fn hand_over_to_running(opts: &Opts, paths: &Paths) -> Result<bool, String> {
    let base = format!("http://127.0.0.1:{}", opts.port);
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    let Ok(response) = client.get(format!("{base}/health")).send() else { return Ok(false) };
    let health: serde_json::Value = response.json().unwrap_or_default();
    if health["app"] == OLD_NAME {
        return Err(format!("The Gestalts Connector, this app's earlier version, still runs on port {}. Quit it from its tray icon, \
                            uninstall it, and start {TITLE} again.", opts.port));
    }
    if health["app"] != NAME { return Err(format!("port {} is used by another program", opts.port)); }
    let token = std::fs::read_to_string(paths.control_token_file()).unwrap_or_default();
    match client.post(format!("{base}/control/show")).header(CONTROL_HEADER, token.trim()).send() {
        Ok(r) if r.status().is_success() => Ok(true),
        _ => Err(format!("another {TITLE} (a different install or profile) already runs on port {}; quit it first", opts.port)),
    }
}

/// What the node's web frontend may ask of this app.
struct DesktopShell {
    send: Sender,
    autostart: Option<auto_launch::AutoLaunch>,
}

impl Shell for DesktopShell {
    fn show(&self) { (self.send)(Msg::Show); }
    fn quit(&self) { (self.send)(Msg::Quit); }
    fn folder_changed(&self, folder: Option<&FolderInfo>) { (self.send)(Msg::FolderChanged(folder.cloned())); }

    fn choose_folder(&self) -> Option<PathBuf> {
        let (tx, rx) = mpsc::channel();
        (self.send)(Msg::PickFolder(tx));
        rx.recv().ok().flatten()
    }

    fn reveal(&self, path: &Path) -> Result<(), String> { opener::open(path).map_err(|e| e.to_string()) }

    fn autostart(&self) -> Option<bool> { self.autostart.as_ref().and_then(|a| a.is_enabled().ok()) }

    fn set_autostart(&self, on: bool) -> Result<(), String> {
        let a = self.autostart.as_ref().ok_or("starting on login isn't available here")?;
        if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
    }
}

fn pick_folder() -> Option<PathBuf> {
    rfd::FileDialog::new().set_title("Choose your gestalter folder").pick_folder()
}

/// Start on login under `name` (plus the profile), pointing at the installed binary (or the AppImage, whose mount
/// path changes per run).
fn autostart(opts: &Opts, name: &str) -> Option<auto_launch::AutoLaunch> {
    let exe = std::env::var("APPIMAGE").ok().or_else(|| std::env::current_exe().ok().map(|p| p.display().to_string()))?;
    let name = opts.profile.as_ref().map_or_else(|| name.to_owned(), |p| format!("{name}-{p}"));
    let mut args = vec!["--background".to_owned()];
    if let Some(p) = &opts.profile { args.extend(["--profile".to_owned(), p.clone()]); }
    if opts.port != 7717 { args.extend(["--port".to_owned(), opts.port.to_string()]); }
    auto_launch::AutoLaunchBuilder::new().set_app_name(&name).set_app_path(&exe).set_args(&args).build().ok()
}

/// "Start on login" chosen under the old name moves to this one.
fn migrate_autostart(opts: &Opts, new: Option<&auto_launch::AutoLaunch>) {
    let (Some(old), Some(new)) = (autostart(opts, OLD_NAME), new) else { return };
    if old.is_enabled().unwrap_or(false) && old.disable().is_ok() && let Err(e) = new.enable() {
        eprintln!("gestalter: cannot move start on login to the new name: {e}");
    }
}

fn tray_icon() -> Result<tray_icon::Icon, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(ICON));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut rgba = vec![0; reader.output_buffer_size().ok_or("icon too large")?];
    let info = reader.next_frame(&mut rgba).map_err(|e| e.to_string())?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight { return Err("the icon isn't 8-bit RGBA".into()); }
    rgba.truncate(info.buffer_size());
    tray_icon::Icon::from_rgba(rgba, info.width, info.height).map_err(|e| e.to_string())
}

/// The tray and the server.
struct App {
    server: Option<Server>,
    _tray: Option<TrayIcon>,
    folder_item: MenuItem,
    open: MenuId,
    choose: MenuId,
    quit: MenuId,
    /// where the gestalter is: the node's own address, or the dev server's
    open_url: String,
    http: reqwest::blocking::Client,
}

impl App {
    fn start(opts: Opts, paths: Paths, open_url: Option<String>, send: Sender) -> Result<App, String> {
        let folder = gestalts_node::remembered_folder(&paths);
        let label = folder_label(folder.as_ref().map(|f| f.info()));
        let no_folder = folder.is_none();
        let new_autostart = autostart(&opts, NAME);
        migrate_autostart(&opts, new_autostart.as_ref());
        let shell = Arc::new(DesktopShell { send: send.clone(), autostart: new_autostart });
        let server = gestalts_node::start_server(&opts, EMBEDDED, paths, folder, true, shell)?;
        { let send = send.clone(); server.spawn(async move { gestalts_node::stop_requested().await; send(Msg::Quit); }); }

        let folder_item = MenuItem::new(&label, false, None);
        let open = MenuItem::new(format!("Open {TITLE}"), true, None);
        let choose = MenuItem::new("Choose folder…", true, None);
        let quit = MenuItem::new("Quit", true, None);
        let menu = Menu::new();
        menu.append_items(&[&folder_item, &PredefinedMenuItem::separator(), &open, &choose, &PredefinedMenuItem::separator(), &quit])
            .map_err(|e| e.to_string())?;
        { let send = send.clone(); MenuEvent::set_event_handler(Some(move |e: MenuEvent| send(Msg::Menu(e.id)))); }
        TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { send(Msg::Show); }
        }));
        let tray = TrayIconBuilder::new()
            .with_id(NAME)
            .with_title(TITLE)
            .with_tooltip(format!("{TITLE}: {label}"))
            .with_icon(tray_icon()?)
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .build();
        // without a tray (e.g. GNOME without an extension), launching the app again still opens the gestalter
        let tray = tray.map_err(|e| eprintln!("gestalter: no tray icon: {e}")).ok();
        let open_url = open_url.unwrap_or_else(|| format!("{}/", server.address));
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
        let app = App { server: Some(server), _tray: tray, folder_item, open: open.id().clone(), choose: choose.id().clone(),
                        quit: quit.id().clone(), open_url, http };
        // launching the app opens it; only the login autostart starts it silently, unless there's no folder yet
        if !opts.background || no_folder { app.open_gestalter(); }
        Ok(app)
    }

    /// Handles one message; `false` means quit.
    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Show => self.open_gestalter(),
            Msg::FolderChanged(info) => {
                let label = folder_label(info.as_ref());
                self.folder_item.set_text(&label);
                if let Some(tray) = &self._tray { let _ = tray.set_tooltip(Some(format!("{TITLE}: {label}"))); }
            }
            Msg::PickFolder(reply) => { let _ = reply.send(pick_folder()); }
            Msg::Quit => return false,
            Msg::Menu(id) if id == self.open => self.open_gestalter(),
            Msg::Menu(id) if id == self.choose => self.choose_folder(),
            Msg::Menu(id) if id == self.quit => return false,
            Msg::Menu(_) => {}
        }
        true
    }

    fn open_gestalter(&self) {
        if let Err(e) = opener::open_browser(&self.open_url) { error_dialog(&format!("Cannot open {}: {e}", self.open_url)); }
    }

    /// From the tray: the picker, then the node opens the folder as if the gestalter had asked.
    fn choose_folder(&self) {
        let (Some(server), Some(path)) = (&self.server, pick_folder()) else { return };
        let sent = self.http.post(format!("{}/control/folder", server.address)).header(CONTROL_HEADER, &server.control_token)
            .json(&serde_json::json!({ "path": path })).send();
        match sent {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => error_dialog(&r.text().unwrap_or_default()),
            Err(e) => error_dialog(&e.to_string()),
        }
    }

    fn shutdown(&mut self) {
        if let Some(server) = self.server.take() { server.stop(); }
    }
}

fn folder_label(info: Option<&FolderInfo>) -> String {
    info.map_or_else(|| "No folder chosen".to_owned(), |f| format!("Folder: {}", f.path))
}

/// Linux: the tray talks D-Bus on its own thread, so the main thread just handles messages.
#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn run(opts: Opts, paths: Paths, open_url: Option<String>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let tx = Mutex::new(tx);
        let mut app = App::start(opts, paths, open_url, Arc::new(move |m| { let _ = tx.lock().expect("sender lock").send(m); }))?;
        while let Ok(msg) = rx.recv() {
            if !app.handle(msg) { break; }
        }
        app.shutdown();
        Ok(())
    }
}

/// macOS and Windows: the tray needs an event loop on the main thread.
#[cfg(not(target_os = "linux"))]
mod platform {
    use super::*;
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};

    pub fn run(opts: Opts, paths: Paths, open_url: Option<String>) -> Result<(), String> {
        let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
        let proxy = Mutex::new(event_loop.create_proxy());
        let send: Sender = Arc::new(move |m| { let _ = proxy.lock().expect("proxy lock").send_event(m); });
        let mut start = Some((opts, paths, open_url, send));
        let mut app: Option<App> = None;
        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                // macOS wants the tray created once the loop runs
                Event::NewEvents(StartCause::Init) => {
                    let (opts, paths, open_url, send) = start.take().expect("started once");
                    match App::start(opts, paths, open_url, send) {
                        Ok(a) => app = Some(a),
                        Err(e) => {
                            error_dialog(&e);
                            *control_flow = ControlFlow::ExitWithCode(1);
                        }
                    }
                }
                Event::UserEvent(msg) => {
                    if let Some(a) = app.as_mut() && !a.handle(msg) {
                        a.shutdown();
                        *control_flow = ControlFlow::Exit;
                    }
                }
                _ => {}
            }
        });
    }
}
