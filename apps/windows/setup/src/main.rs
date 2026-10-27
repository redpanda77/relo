//! Relo Setup (relo-windows-setup.exe, served at /windows/relo-setup.exe): the file people download.
//!
//! It carries the NSIS installer that scripts/release/build-windows-app.mjs builds, shows a Relo window (WebView2, ui.html)
//! and runs that installer silently in the meantime: no wizard, no questions, no administrator prompt (the install is per
//! user). When it is done it opens Relo and goes away. The way Discord's and Slack's setup (Squirrel) feel: launching the
//! setup feels like opening the app.
//!
//!   relo-windows-setup.exe              the window, install, open Relo
//!   relo-windows-setup.exe /S           no window, nothing opened (IT, install.ps1); the installer's exit code is returned
//!   anything else (/D=<folder>, /P ...) goes through to the NSIS installer
//!
//! The browser marked this file with a Mark-of-the-Web (its Zone.Identifier stream) when it was downloaded; the installer it
//! extracts has none. So this program reads the mark, and when it names a Relo server it writes
//! %LOCALAPPDATA%\Relo\install-source.json and starts Relo with `--relo-origin <origin>`.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("Relo Setup is a Windows program.");
}

#[cfg(windows)]
fn main() {
    app::run();
}

#[cfg(windows)]
mod app {
    use relo_setup::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tao::dpi::{LogicalSize, PhysicalPosition};
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::platform::windows::WindowBuilderExtWindows;
    use tao::window::WindowBuilder;
    use wry::{WebContext, WebViewBuilder};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    /// The NSIS installer (empty in a build without one).
    static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.bin"));
    static ICON: &[u8] = include_bytes!("../../src-tauri/icons/128x128.png");
    static PAGE: &str = include_str!("ui.html");

    #[derive(Debug)]
    enum Ui {
        State(&'static str),
        Ipc(String),
        Quit,
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if is_silent(&args) {
            // IT and install.ps1: no window, nothing opened, the installer's own exit code.
            let code = match install(&args, false, &|_| {}) {
                Ok(()) => 0,
                Err(e) => e.code,
            };
            std::process::exit(code);
        }
        if !window(args.clone()) {
            // WebView2 is not here (a few Windows 10 PCs): no window, but the install still works (the installer brings
            // WebView2 itself), and only a failure says anything.
            match install(&args, true, &|_| {}) {
                Ok(()) => {}
                Err(_) => message_box(words("failed")),
            }
        }
    }

    #[derive(Debug)]
    struct Failure {
        code: i32,
        #[allow(dead_code)]
        detail: String,
    }

    fn fail(code: i32, detail: impl Into<String>) -> Failure {
        Failure { code, detail: detail.into() }
    }

    fn local_app_data() -> String {
        std::env::var("LOCALAPPDATA").unwrap_or_default()
    }

    /// Relo.exe of the installed copy: the default folder, else the folder the installer recorded for this user (read only).
    fn find_relo_exe() -> Option<PathBuf> {
        let default = PathBuf::from(default_relo_exe(&local_app_data()));
        if default.exists() {
            return Some(default);
        }
        let out = Command::new("reg")
            .args(["query", r"HKCU\Software\Relo\Relo", "/ve"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let dir = install_dir_from_reg_query(&String::from_utf8_lossy(&out.stdout))?;
        let exe = PathBuf::from(dir).join("Relo.exe");
        exe.exists().then_some(exe)
    }

    /// This program's Mark-of-the-Web, when the download carries one and it names a Relo server.
    fn download_origin() -> Option<String> {
        let exe = std::env::current_exe().ok()?;
        let stream = format!("{}:Zone.Identifier", exe.display());
        let bytes = std::fs::read(stream).ok()?;
        origin_from_zone_identifier(&decode_stream(&bytes))
    }

    /// Runs the installer. `open` says whether Relo is started afterwards (a window install; the silent one leaves that out).
    fn install(args: &[String], open: bool, ui: &dyn Fn(Ui)) -> Result<(), Failure> {
        if PAYLOAD.is_empty() {
            ui(Ui::State("needsinstaller"));
            return Err(fail(1, "this Relo Setup carries no installer"));
        }
        let origin = download_origin();
        let folder = std::env::temp_dir().join(format!("relo-setup-{}", std::process::id()));
        std::fs::create_dir_all(&folder).map_err(|e| fail(2, format!("temp folder: {e}")))?;
        let inner = folder.join("Relo-Setup.exe");
        let result = (|| {
            std::fs::write(&inner, PAYLOAD).map_err(|e| fail(2, format!("unpack: {e}")))?;
            // /S for the installer's own window, then what the person gave this program; /D=<folder> stays last.
            let status = Command::new(&inner)
                .raw_arg(nsis_command_line(args))
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|e| fail(2, format!("run: {e}")))?;
            if status.success() { Ok(()) } else { Err(fail(status.code().unwrap_or(1), "the installer stopped")) }
        })();
        let _ = std::fs::remove_dir_all(&folder);
        result?;

        if let Some(origin) = &origin {
            let path = PathBuf::from(install_source_path(&local_app_data()));
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, install_source_json(origin));
        }
        if !open {
            return Ok(());
        }
        ui(Ui::State("opening"));
        match find_relo_exe() {
            Some(exe) => open_relo(&exe, origin.as_deref()),
            None => ui(Ui::State("done")),
        }
        Ok(())
    }

    /// Starts Relo, detached, and waits (a few seconds at most) until it has a window up, so the setup window hands over
    /// to Relo's without a gap.
    fn open_relo(exe: &PathBuf, origin: Option<&str>) {
        let mut command = Command::new(exe);
        if let Some(origin) = origin {
            command.args(["--relo-origin", origin]);
        }
        if let Some(dir) = exe.parent() {
            command.current_dir(dir);
        }
        let Ok(child) = command.creation_flags(DETACHED_PROCESS | NEW_PROCESS_GROUP).spawn() else { return };
        let pid = child.id();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(150));
            if started.elapsed() > Duration::from_millis(1200) && has_visible_window(pid) {
                break;
            }
        }
    }

    fn has_visible_window(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
        struct Search {
            pid: u32,
            found: bool,
        }
        unsafe extern "system" fn each(window: HWND, param: LPARAM) -> i32 {
            let search = &mut *(param as *mut Search);
            let mut owner = 0u32;
            GetWindowThreadProcessId(window, &mut owner);
            if owner == search.pid && IsWindowVisible(window) != 0 {
                search.found = true;
                return 0;
            }
            1
        }
        let mut search = Search { pid, found: false };
        unsafe { EnumWindows(Some(each), &mut search as *mut Search as LPARAM) };
        search.found
    }

    fn message_box((head, small): (&str, &str)) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let text = wide(&format!("{head}\n\n{small}"));
        let caption = wide("Relo Setup");
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR) };
    }

    fn base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
        for chunk in bytes.chunks(3) {
            let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
            out.push(TABLE[(n >> 18) as usize & 63] as char);
            out.push(TABLE[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
        }
        out
    }

    fn script_for(state: &str) -> String {
        let (head, small) = words(state);
        let js = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
        format!("window.setState({},{},{})", js(state), js(head), js(small))
    }

    /// Shows the window and runs the install behind it. False when there is no WebView2 to draw it with.
    fn window(args: Vec<String>) -> bool {
        let event_loop = EventLoopBuilder::<Ui>::with_user_event().build();
        let proxy = event_loop.create_proxy();
        let size = LogicalSize::new(420.0, 300.0);
        let built = WindowBuilder::new()
            .with_title("Relo Setup")
            .with_inner_size(size)
            .with_resizable(false)
            .with_maximizable(false)
            .with_decorations(false)
            .with_transparent(true)
            .with_undecorated_shadow(false)
            .with_visible(false)
            .build(&event_loop);
        let Ok(window) = built else { return false };
        if let Some(monitor) = window.primary_monitor() {
            let (m, w) = (monitor.size(), window.outer_size());
            let origin = monitor.position();
            window.set_outer_position(PhysicalPosition::new(
                origin.x + (m.width as i32 - w.width as i32) / 2,
                origin.y + (m.height as i32 - w.height as i32) / 2,
            ));
        }

        let data = std::env::temp_dir().join(format!("relo-setup-ui-{}", std::process::id()));
        let mut context = WebContext::new(Some(data.clone()));
        let page = PAGE.replace("__ICON__", &base64(ICON));
        let ipc_proxy = proxy.clone();
        let webview = WebViewBuilder::new_with_web_context(&mut context)
            .with_transparent(true)
            .with_html(page)
            .with_ipc_handler(move |request| {
                let _ = ipc_proxy.send_event(Ui::Ipc(request.body().clone()));
            })
            .build(&window);
        let Ok(webview) = webview else { return false };
        window.set_visible(true);

        let args = Arc::new(args);
        let running = Arc::new(Mutex::new(false));
        let state = Arc::new(Mutex::new("installing"));
        let start = {
            let (proxy, args, running) = (proxy.clone(), args.clone(), running.clone());
            move || {
                let mut guard = running.lock().unwrap();
                if *guard {
                    return;
                }
                *guard = true;
                let (proxy, args, running) = (proxy.clone(), args.clone(), running.clone());
                std::thread::spawn(move || {
                    let updating = find_relo_exe().is_some();
                    let _ = proxy.send_event(Ui::State(if updating { "updating" } else { "installing" }));
                    let report = |ui: Ui| {
                        let _ = proxy.send_event(ui);
                    };
                    let outcome = install(&args, true, &report);
                    *running.lock().unwrap() = false;
                    match outcome {
                        Ok(()) => {
                            // A moment on "Opening Relo" (or "Relo is installed"), then the window goes.
                            std::thread::sleep(Duration::from_millis(600));
                            let _ = proxy.send_event(Ui::Quit);
                        }
                        Err(_) => {
                            let _ = proxy.send_event(Ui::State("failed"));
                        }
                    }
                });
            }
        };
        start();

        let keep_alive = (context, data);
        event_loop.run(move |event, _, flow| {
            let _ = &keep_alive;
            *flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(Ui::State(next)) => {
                    *state.lock().unwrap() = next;
                    let _ = webview.evaluate_script(&script_for(next));
                }
                Event::UserEvent(Ui::Ipc(message)) => match message.as_str() {
                    "drag" => {
                        let _ = window.drag_window();
                    }
                    "retry" if *state.lock().unwrap() == "failed" => {
                        *state.lock().unwrap() = "installing";
                        let _ = webview.evaluate_script(&script_for("installing"));
                        start();
                    }
                    // The window closes by itself when the install is done; before that only a failure can be closed.
                    "close" if matches!(*state.lock().unwrap(), "failed" | "needsinstaller") => *flow = ControlFlow::Exit,
                    _ => {}
                },
                Event::UserEvent(Ui::Quit) => *flow = ControlFlow::Exit,
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                    if matches!(*state.lock().unwrap(), "failed" | "needsinstaller") {
                        *flow = ControlFlow::Exit;
                    }
                }
                _ => {}
            }
        });
    }
}
