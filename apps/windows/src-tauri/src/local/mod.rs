//! "Run Relo on this PC": local mode, the Windows twin of the Mac's LocalServer / ReloLocalMode / ReloServerService.
//! The app carries a server, Node and the relo CLI (`<exe dir>\server\`; in dev, RELO_LOCAL_PAYLOAD), runs them under
//! the logon task (or itself in dev), keeps its data in `%LOCALAPPDATA%\Relo\server`, and links this PC to it without a
//! sign-in the owner sees. Events: `local_state` (to every window) and `local_sign_in` (to the notch, which signs in).
//! Commands are in this file; the rules are in the modules, each tested without a server.

pub mod flow;
pub mod health;
pub mod host;
pub mod invite;
pub mod launcher;
pub mod paths;
pub mod runner;
pub mod server;

use crate::settings_window::Agent;
use flow::{LocalState, ModeFile, SignIn, StateCell};
use host::WindowsHost;
use runner::RealRunner;
use serde::Serialize;
use server::LocalServer;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

struct Ctx {
    server: LocalServer,
    cell: StateCell,
    /// One start, link or uninstall at a time.
    busy: Mutex<()>,
}

static CTX: OnceLock<Ctx> = OnceLock::new();

/// This app's release as the server reports it when current: the payload's `release-identity.txt` (the one value the
/// payload build wrote, that ReloServer.exe hands the server as RELO_RELEASE_IDENTITY and the app compares health.release
/// with), else this build's package version.
pub fn app_release(payload: Option<&paths::Payload>) -> String {
    payload.and_then(paths::Payload::release_identity).unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn ctx() -> Result<&'static Ctx, String> {
    CTX.get().ok_or_else(|| "Relo could not find its folder.".to_string())
}

// ---- This PC ----

pub fn is_x64() -> bool {
    std::env::consts::ARCH == "x86_64"
}

#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(token, TokenElevation, Some(&mut elevation as *mut _ as *mut _), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len).is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// The Windows build number (RtlGetVersion reports the real one, whatever the app's manifest says).
#[cfg(windows)]
pub fn windows_build() -> Option<u32> {
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }
    let mut info = OsVersionInfo { size: std::mem::size_of::<OsVersionInfo>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
    (unsafe { RtlGetVersion(&mut info) } == 0).then_some(info.build)
}

#[cfg(not(windows))]
pub fn windows_build() -> Option<u32> {
    None
}

/// Why this PC cannot run Relo on it (too old a Windows, not x64, run as administrator), in the owner's words.
fn pc_problem() -> Option<String> {
    LocalServer::os_problem(windows_build()).or_else(|| LocalServer::setup_problem(is_x64(), is_elevated()))
}

fn computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

// ---- Startup ----

/// Call once from setup. Builds the local server from the environment, and when local mode is on, starts it (and keeps
/// the state current).
pub fn init(app: &AppHandle) {
    let Some(paths) = paths::Paths::from_env() else { return };
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let payload_env = std::env::var_os(paths::PAYLOAD_ENV);
    let payload = paths::find_payload(payload_env.as_deref(), exe_dir.as_deref());
    // Without a payload (a dev build) nothing runs; the host still needs a folder to point at.
    let host_payload = payload.clone().unwrap_or(paths::Payload { folder: paths.relo_root.join("no-payload") });
    let runner: Arc<dyn runner::Runner> = Arc::new(RealRunner);
    let release = app_release(payload.as_ref());
    let host = Arc::new(WindowsHost { runner: runner.clone(), payload: host_payload, paths: paths.clone(), release: release.clone() });
    let server = LocalServer::new(payload, paths.clone(), release, runner, host, Box::new(health::fetch_health));
    let bundled = server.is_bundled();
    let mode = bundled && flow::read_mode(&paths.mode_file()).on;
    let handle = app.clone();
    let cell = StateCell::new(LocalState { mode, ..LocalState::off(bundled) }, move |s| {
        let _ = handle.emit("local_state", s);
    });
    if CTX.set(Ctx { server, cell, busy: Mutex::new(()) }).is_err() {
        return;
    }
    let handle = app.clone();
    let onboarding_pending = onboarding_pending();
    std::thread::spawn(move || watch(&handle, mode, onboarding_pending));
}

/// Every launch with local mode on: keep the background server current with this app, and refresh the agents after an
/// update. Until the server answers the notch says "Starting Relo…"; when it cannot start, it says so, with Try again.
/// Then, for as long as the app runs, the state follows what answers.
fn watch(app: &AppHandle, mode_on: bool, onboarding_pending: bool) {
    let Ok(c) = ctx() else { return };
    if mode_on {
        on_launch(app, c);
    } else if onboarding_pending {
        // A setup that quit half way leaves no background server running behind the onboarding.
        let _g = c.busy.lock().unwrap();
        flow::clean_up_half_setup(&c.server, &c.server.paths.mode_file());
    }
    loop {
        std::thread::sleep(Duration::from_secs(5));
        if let Ok(_idle) = c.busy.try_lock() {
            flow::observe(&c.server, &c.cell);
        }
    }
}

/// The owner has not finished onboarding (the Settings window opens on it at launch, settings_window.rs).
fn onboarding_pending() -> bool {
    let Some(base) = std::env::var_os("APPDATA") else { return true };
    let path = std::path::PathBuf::from(base).join(crate::profile::app_dir()).join("settings.json");
    crate::settings_window::read_file(&path).get("onboardingDone") != Some(&serde_json::json!(true))
}

fn on_launch(app: &AppHandle, c: &'static Ctx) {
    let started = {
        let _g = c.busy.lock().unwrap();
        flow::start(&c.server, &c.cell, Duration::from_secs(60), Duration::from_secs(20), &|| {})
    };
    if started.is_none() {
        c.server.refresh_launcher_if_moved();
        let mode_path = c.server.paths.mode_file();
        let mut mode = flow::read_mode(&mode_path);
        let release = c.server.app_release.clone();
        if mode.last_release.as_deref() != Some(release.as_str()) {
            let first = mode.last_release.is_none();
            mode.last_release = Some(release);
            let _ = flow::write_mode(&mode_path, &mode);
            if !first {
                // The result is the "Updated to …" moment; the agents' files are refreshed (60 s at most).
                let agents = if c.server.refresh_agents(Duration::from_secs(60)).is_ok() { "refreshed" } else { "failed" };
                let _ = app.emit("local_updated", serde_json::json!({ "version": c.cell.get().version, "agents": agents }));
            }
        }
    }
}

// ---- Commands ----

#[tauri::command]
pub fn local_state_get() -> LocalState {
    match ctx() {
        Ok(c) => c.cell.get(),
        Err(_) => LocalState::off(false),
    }
}

/// Why local setup cannot go ahead here, in words for the owner; None when it can.
#[tauri::command]
pub fn local_check() -> Option<String> {
    if let Some(p) = pc_problem() {
        return Some(p);
    }
    match ctx() {
        Ok(c) if c.server.is_bundled() => None,
        _ => Some(server::NOT_BUNDLED_MESSAGE.to_string()),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())
}

/// Starts Relo on this PC: first-run preparation when there is no data yet, the logon task, then waits until it answers
/// (and restarts an older one). The first step of the setup and "Try again". Returns the state; Err has the words.
#[tauri::command]
pub async fn local_start() -> Result<LocalState, String> {
    blocking(|| {
        let c = ctx()?;
        if let Some(problem) = pc_problem() {
            return Err(problem);
        }
        let _g = c.busy.lock().unwrap();
        c.cell.starting();
        if c.server.config().is_none() {
            if let Err(e) = c.server.prepare() {
                c.cell.failed(&e);
                return Err(e);
            }
        }
        match flow::start(&c.server, &c.cell, Duration::from_secs(120), Duration::from_secs(20), &|| {}) {
            None => Ok(c.cell.get()),
            Some(e) => Err(e),
        }
    })
    .await?
}

/// The agents on this PC, read without changing anything.
#[tauri::command]
pub async fn local_detect_agents() -> Vec<Agent> {
    blocking(|| ctx().map(|c| c.server.detect_agents()).unwrap_or_default()).await.unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub result: launcher::LauncherResult,
    /// Set when the owner's own relo command stays in place.
    pub note: Option<String>,
}

/// The relo command: the launcher, the user Path, and the CLI's updates handed to the app.
#[tauri::command]
pub async fn local_install_command() -> Result<CommandResult, String> {
    blocking(|| {
        let c = ctx()?;
        let result = c.server.install_launcher()?;
        c.server.set_up_path()?;
        // Another relo command keeps updating itself: it is the owner's, not the app's.
        if result == launcher::LauncherResult::Written {
            c.server.set_managed_updates()?;
            Ok(CommandResult { result, note: None })
        } else {
            Ok(CommandResult { result, note: Some(launcher::OTHER_LAUNCHER_NOTE.to_string()) })
        }
    })
    .await?
}

fn hand_to_notch(app: &AppHandle, sign_in: &SignIn) {
    let _ = app.emit_to("notch", "local_sign_in", sign_in);
}

/// Links the relo command and the app to Relo on this PC: an invite, the join into the `local` profile (which sets up
/// `agents`, or nothing when `set_up` is false), then the notch signs itself in with the returned code.
#[tauri::command]
pub async fn local_link(app: AppHandle, agents: Vec<String>, set_up: bool) -> Result<(), String> {
    if !agents.iter().all(|a| crate::settings_window::valid_agent_id(a)) {
        return Err("invalid agent id".into());
    }
    blocking(move || {
        let c = ctx()?;
        let _g = c.busy.lock().unwrap();
        let sign_in = flow::link(&c.server, &agents, set_up, computer_name().as_deref())?;
        hand_to_notch(&app, &sign_in);
        Ok(())
    })
    .await?
}

/// The setup worked: local mode is on from now on (the Mac sets its flag when the sign-in did).
#[tauri::command]
pub fn local_commit() -> Result<LocalState, String> {
    let c = ctx()?;
    let path = c.server.paths.mode_file();
    flow::write_mode(&path, &ModeFile { on: true, last_release: Some(c.server.app_release.clone()) })?;
    c.cell.update(|s| s.mode = true);
    Ok(c.cell.get())
}

/// The setup is done: a test card waits in the notch for the owner to answer, so the whole path is seen to work.
#[tauri::command]
pub async fn local_test_card() {
    let _ = blocking(|| {
        if let Ok(c) = ctx() {
            let _ = c.server.raise_test_card();
        }
    })
    .await;
}

/// The notch lost its link (credential refused or lost): link again without asking anything. Returns what went wrong.
#[tauri::command]
pub async fn local_repair(app: AppHandle) -> Option<String> {
    blocking(move || {
        let c = ctx().ok()?;
        let _g = c.busy.lock().unwrap();
        if let Some(e) = flow::start(&c.server, &c.cell, Duration::from_secs(60), Duration::from_secs(20), &|| {}) {
            return Some(e);
        }
        match flow::link(&c.server, &[], false, computer_name().as_deref()) {
            Ok(sign_in) => {
                hand_to_notch(&app, &sign_in);
                None
            }
            Err(e) => Some(e),
        }
    })
    .await
    .unwrap_or_else(|e| Some(e))
}

/// Sets up the chosen agents (Settings, "Set up agents again").
#[tauri::command]
pub async fn local_set_up_agents(agents: Vec<String>) -> Option<String> {
    if !agents.iter().all(|a| crate::settings_window::valid_agent_id(a)) {
        return Some("invalid agent id".into());
    }
    blocking(move || {
        let c = ctx().ok()?;
        c.server.set_up_agents(&agents, &computer_name().unwrap_or_else(|| "This PC".into()), "guide").err()
    })
    .await
    .unwrap_or_else(|e| Some(e))
}

/// "Use another": Relo on this PC stops so the app can start over against a server. Returns what went wrong, or None.
#[tauri::command]
pub async fn local_leave(ignoring_problems: Option<bool>) -> Option<String> {
    blocking(move || {
        let c = ctx().ok()?;
        let _g = c.busy.lock().unwrap();
        let problem = flow::leave_for_server(&c.server, &c.server.paths.mode_file(), ignoring_problems.unwrap_or(false));
        if problem.is_none() {
            c.cell.update(|s| *s = LocalState::off(s.bundled));
        }
        problem
    })
    .await
    .unwrap_or_else(|e| Some(e))
}

/// Backing out of a setup that did not finish: nothing stays half installed.
#[tauri::command]
pub async fn local_abandon() {
    let _ = blocking(|| {
        if let Ok(c) = ctx() {
            let _g = c.busy.lock().unwrap();
            flow::abandon(&c.server, &c.server.paths.mode_file());
            c.cell.update(|s| *s = LocalState::off(s.bundled));
        }
    })
    .await;
}

/// Removes what Relo set up on this PC, after the owner confirmed it. Returns every problem in words, or None.
#[tauri::command]
pub async fn local_uninstall(delete_data: bool) -> Option<String> {
    blocking(move || {
        let c = ctx().ok()?;
        let _g = c.busy.lock().unwrap();
        let problem = flow::uninstall(&c.server, &c.server.paths.mode_file(), delete_data, Duration::from_secs(30));
        c.cell.update(|s| *s = LocalState::off(s.bundled));
        problem
    })
    .await
    .unwrap_or_else(|e| Some(e))
}

/// The host of a server this PC's relo command is signed in to, to name it before moving to Relo on this PC.
#[tauri::command]
pub fn local_remote_host() -> Option<String> {
    ctx().ok().and_then(|c| c.server.existing_remote_login_host())
}

/// Opens the folder Relo's server writes its logs to (made first, so the button always opens something).
#[tauri::command]
pub fn local_show_logs() -> Result<(), String> {
    let c = ctx()?;
    let dir = c.server.paths.logs();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(&dir);
    runner::no_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
