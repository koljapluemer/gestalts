//! The tray: one bridge per user, as a tray icon with whether Claude Code was found, the sites allowed to use it,
//! "Start on login" and "Quit". Dialogs (a site asking to be allowed) are shown from the main thread, which macOS
//! and Windows need.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder};

use crate::config::{Paths, Settings};
use crate::server::{Asker, Bridge};
use crate::{ICON, NAME, TITLE};

pub enum Msg {
    Ask(String, mpsc::Sender<bool>),
    Claude(String),
    Menu(MenuId),
    Quit,
}

type Sender = Arc<dyn Fn(Msg) + Send + Sync>;

/// Whether the person lets `origin` run Claude here.
pub fn ask_allow(origin: &str) -> bool {
    let answer = rfd::MessageDialog::new()
        .set_title(TITLE)
        .set_level(rfd::MessageLevel::Warning)
        .set_description(format!(
            "Allow {origin} to run Claude Code on this computer?\n\nIt can then have Claude read and change the files it \
             sends here, on your Claude account and its usage limits. Allow only sites you trust. You can take it back \
             from the tray icon (Allowed sites)."))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show();
    answer == rfd::MessageDialogResult::Yes
}

fn info(message: &str) {
    let _ = rfd::MessageDialog::new().set_title(TITLE).set_description(message).show();
}

fn error_dialog(message: &str) {
    let _ = rfd::MessageDialog::new().set_title(TITLE).set_description(message).set_level(rfd::MessageLevel::Error).show();
}

struct TrayAsker(Sender);
impl Asker for TrayAsker {
    fn allow(&self, origin: &str) -> bool {
        let (tx, rx) = mpsc::channel();
        (self.0)(Msg::Ask(origin.to_owned(), tx));
        rx.recv().unwrap_or(false)
    }
}

pub fn run(port: u16, profile: Option<&str>, background: bool) -> Result<(), String> {
    let result = (|| {
        if already_running(port, background)? { return Ok(()); }
        let paths = Paths::new(profile)?;
        platform::run(port, paths, profile.map(str::to_owned), background)
    })();
    // started from the app menu or on login, nobody sees stderr
    if let Err(e) = &result { error_dialog(e); }
    result
}

/// `true` if this bridge already runs on the port (and says so, unless started on login).
fn already_running(port: u16, background: bool) -> Result<bool, String> {
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
    let Ok(r) = http.get(format!("http://127.0.0.1:{port}/status")).send() else { return Ok(false) };
    let status: serde_json::Value = r.json().unwrap_or_default();
    if status["app"] != NAME { return Err(format!("port {port} is used by another program")); }
    if !background { info(&format!("{TITLE} already runs: find it in the tray.")); }
    Ok(true)
}

/// Start on login, pointing at the installed binary (or the AppImage, whose mount path changes per run).
fn autostart(port: u16, profile: Option<&str>) -> Option<auto_launch::AutoLaunch> {
    let exe = std::env::var("APPIMAGE").ok().or_else(|| std::env::current_exe().ok().map(|p| p.display().to_string()))?;
    let name = profile.map_or_else(|| NAME.to_owned(), |p| format!("{NAME}-{p}"));
    let mut args = vec!["--background".to_owned()];
    if let Some(p) = profile { args.extend(["--profile".to_owned(), p.to_owned()]); }
    if port != crate::PORT { args.extend(["--port".to_owned(), port.to_string()]); }
    auto_launch::AutoLaunchBuilder::new().set_app_name(&name).set_app_path(&exe).set_args(&args).build().ok()
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

struct App {
    bridge: Arc<Bridge>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    server: Option<std::thread::JoinHandle<()>>,
    _tray: Option<TrayIcon>,
    claude_item: MenuItem,
    sites: MenuId,
    login: CheckMenuItem,
    quit: MenuId,
    autostart: Option<auto_launch::AutoLaunch>,
}

impl App {
    fn start(port: u16, paths: Paths, profile: Option<String>, background: bool, send: Sender) -> Result<App, String> {
        let bridge = Bridge::new(paths.clone(), false, Arc::new(TrayAsker(send.clone())))?;
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        let listener = rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", port))).map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = {
            let (bridge, send) = (bridge.clone(), send.clone());
            std::thread::spawn(move || {
                rt.block_on(async move {
                    {
                        let (b, label_send) = (bridge.clone(), send.clone());
                        tokio::spawn(async move { label_send(Msg::Claude(claude_label(&b).await)); });
                        tokio::spawn(async move { crate::stop_requested().await; send(Msg::Quit); });
                    }
                    if let Err(e) = crate::server::serve(bridge, listener, async { let _ = stopped.await; }).await {
                        eprintln!("{NAME}: {e}");
                    }
                });
            })
        };

        let claude_item = MenuItem::new("Looking for Claude Code…", false, None);
        let sites = MenuItem::new("Allowed sites…", true, None);
        let autostart = autostart(port, profile.as_deref());
        let on = autostart.as_ref().and_then(|a| a.is_enabled().ok()).unwrap_or(false);
        let login = CheckMenuItem::new("Start on login", autostart.is_some(), on, None);
        let quit = MenuItem::new("Quit", true, None);
        let menu = Menu::new();
        menu.append_items(&[&claude_item, &PredefinedMenuItem::separator(), &sites, &login, &PredefinedMenuItem::separator(), &quit])
            .map_err(|e| e.to_string())?;
        MenuEvent::set_event_handler(Some(move |e: MenuEvent| send(Msg::Menu(e.id))));
        let tray = TrayIconBuilder::new().with_id(NAME).with_title(TITLE).with_tooltip(TITLE).with_icon(tray_icon()?)
            .with_menu(Box::new(menu)).build();
        let tray = tray.map_err(|e| eprintln!("{NAME}: no tray icon: {e}")).ok();
        let app = App { bridge, stop: Some(stop), server: Some(server), _tray: tray, claude_item, sites: sites.id().clone(),
                        login, quit: quit.id().clone(), autostart };
        app.offer_autostart(&paths, background);
        Ok(app)
    }

    /// The first time it's started by hand, it offers to start on login: a bridge that isn't running can't help.
    fn offer_autostart(&self, paths: &Paths, background: bool) {
        let mut settings = Settings::load(paths);
        let Some(a) = &self.autostart else { return };
        if settings.autostart_offered || background { return; }
        settings.autostart_offered = true;
        let _ = settings.save(paths);
        let yes = rfd::MessageDialog::new().set_title(TITLE)
            .set_description(format!("{TITLE} runs in the tray. Start it when you log in, so sites you allow can always reach it?"))
            .set_buttons(rfd::MessageButtons::YesNo).show() == rfd::MessageDialogResult::Yes;
        if yes && a.enable().is_ok() { self.login.set_checked(true); }
    }

    /// Handles one message; `false` means quit.
    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Ask(origin, reply) => { let _ = reply.send(ask_allow(&origin)); }
            Msg::Claude(label) => self.claude_item.set_text(label),
            Msg::Quit => return false,
            Msg::Menu(id) if id == self.quit => return false,
            Msg::Menu(id) if id == self.sites => self.sites(),
            Msg::Menu(id) if id == *self.login.id() => {
                let on = self.login.is_checked();
                if let Some(a) = &self.autostart && let Err(e) = if on { a.enable() } else { a.disable() } {
                    error_dialog(&format!("Cannot change starting on login: {e}"));
                    self.login.set_checked(!on);
                }
            }
            Msg::Menu(_) => {}
        }
        true
    }

    fn sites(&self) {
        let sites: Vec<String> = self.bridge.tokens.lock().expect("tokens lock").0.keys().cloned().collect();
        if sites.is_empty() {
            info("No site may run Claude here yet. A site asks the first time it needs to.");
            return;
        }
        let forget = rfd::MessageDialog::new().set_title(TITLE)
            .set_description(format!("These sites may run Claude Code here:\n\n{}\n\nForget all of them? Each asks again next time.", sites.join("\n")))
            .set_buttons(rfd::MessageButtons::YesNo).show() == rfd::MessageDialogResult::Yes;
        if forget && let Err(e) = self.bridge.forget_all() { error_dialog(&format!("Cannot forget them: {e}")); }
    }

    fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() { let _ = stop.send(()); }
        if let Some(server) = self.server.take() { let _ = server.join(); }
    }
}

async fn claude_label(b: &Bridge) -> String {
    let c = b.claude().await;
    match c.version {
        Some(v) => format!("Claude Code {}", v.split_whitespace().next().unwrap_or(&v)),
        None => "Claude Code not found: install it and sign in".into(),
    }
}

/// Linux: the tray talks D-Bus on its own thread, so the main thread just handles messages.
#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn run(port: u16, paths: Paths, profile: Option<String>, background: bool) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let tx = Mutex::new(tx);
        let mut app = App::start(port, paths, profile, background, Arc::new(move |m| { let _ = tx.lock().expect("sender lock").send(m); }))?;
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

    pub fn run(port: u16, paths: Paths, profile: Option<String>, background: bool) -> Result<(), String> {
        let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
        let proxy = Mutex::new(event_loop.create_proxy());
        let send: Sender = Arc::new(move |m| { let _ = proxy.lock().expect("proxy lock").send_event(m); });
        let mut start = Some((port, paths, profile, background, send));
        let mut app: Option<App> = None;
        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                // macOS wants the tray created once the loop runs
                Event::NewEvents(StartCause::Init) => {
                    let (port, paths, profile, background, send) = start.take().expect("started once");
                    match App::start(port, paths, profile, background, send) {
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
