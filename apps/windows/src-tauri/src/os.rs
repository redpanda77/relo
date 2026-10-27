//! Tauri commands that reach the OS: browser sign-in bridge, secret storage, autostart.
//! All validation lives in `launch`, `secrets` and `autostart` (pure, tested); this file only wires them.

use crate::{autostart, launch, secrets};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_waits_for_this_process_then_starts_the_exe() {
        let a = restart_helper_args(4242, r"C:\Users\O'Neil\Relo\relo.exe");
        let cmd = a.last().unwrap();
        assert!(cmd.starts_with("Wait-Process -Id 4242"));
        assert!(cmd.contains(r"Start-Process -FilePath 'C:\Users\O''Neil\Relo\relo.exe'"));
        assert!(a.iter().any(|x| x == "Hidden"));
    }

    #[test]
    fn launch_stages_are_logged_as_the_macs_lines() {
        assert_eq!(launch_line("firstDraw", 812).as_deref(), Some("launch: first notch draw after 812 ms"));
        assert_eq!(launch_line("liveData", 1500).as_deref(), Some("launch: live data after 1500 ms"));
        assert_eq!(launch_line("windowShown", 90).as_deref(), Some("launch: notch window shown after 90 ms"));
        assert_eq!(launch_line("anything else", 1), None);
    }
}

#[derive(Serialize, Clone)]
struct AuthCallback {
    url: String,
}

/// Last forwarded deep link; the plugin's single-instance hook and our own argv scan can both deliver one.
static LAST_URL: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Validate a `relo://auth/callback` URL and hand it to the page. Anything else is dropped.
pub fn handle_url(app: &AppHandle, raw: &str) {
    let Some(url) = launch::validate_auth_callback(raw) else {
        eprintln!("relo: dropped a deep link that is not relo://auth/callback");
        return;
    };
    {
        let mut last = LAST_URL.lock().unwrap();
        if let Some((u, at)) = last.as_ref() {
            if *u == url && at.elapsed() < Duration::from_secs(3) {
                return;
            }
        }
        *last = Some((url.clone(), Instant::now()));
    }
    let _ = app.emit_to("notch", "auth_callback", AuthCallback { url });
}

/// Scan process arguments (first launch, or argv forwarded by single-instance) for relo:// links.
pub fn handle_args(app: &AppHandle, args: &[String]) {
    // (an earlier version compared 8 bytes against the 7-byte scheme and never matched)
    for a in args.iter().filter(|a| launch::is_relo_link(a)) {
        handle_url(app, a);
    }
}

/// A second launch, forwarded by the single-instance plugin (Mac: `applicationShouldHandleReopen` for the re-open,
/// `signInLocally` for the installer hand-off):
/// - `relo://` links are validated and handed to the page (`handle_args`);
/// - `--relo-origin` / `--relo-sign-in-code` / `--relo-code-verifier` reach the running notch as the `launch_hand_off` event
///   (same shape as the `launch_args` command; the page signs in with it);
/// - a bare launch (the Start menu entry again) brings up the onboarding when it is not done or already open, else Home.
pub fn handle_second_instance(app: &AppHandle, args: &[String]) {
    handle_args(app, args);
    if let Some(hand_off) = launch::parse_launch(args).hand_off {
        let _ = app.emit_to("notch", "launch_hand_off", hand_off);
    }
    if launch::is_reopen(args) {
        reopen(app);
    }
}

fn reopen(app: &AppHandle) {
    use tauri::Manager;
    let onboarding_open = app.get_webview_window("settings").is_some_and(|w| w.is_visible().unwrap_or(false));
    let r = if onboarding_open || !crate::settings_window::onboarding_done() {
        crate::settings_window::open(app, (!crate::settings_window::onboarding_done()).then(|| "onboarding".to_string()))
    } else {
        crate::home_window::open(app)
    };
    if let Err(e) = r {
        eprintln!("relo: could not open a window for the second launch: {e}");
    }
}

// ---- Restart (Mac: ApplicationRelauncher.restart, the "Restart Relo" menu item) ----

/// The helper that starts the app again once this process has exited. Tauri's own `restart()` would start the new process
/// while this one still holds the single-instance mutex, and the new one would hand over to us and quit. The helper waits for
/// this process id to end first.
pub fn restart_helper_args(pid: u32, exe: &str) -> Vec<String> {
    let quoted = exe.replace('\'', "''");
    vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-WindowStyle".into(),
        "Hidden".into(),
        "-Command".into(),
        format!("Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '{quoted}'"),
    ]
}

/// Relaunch Relo and quit this instance (through the quit path, so the quit sound plays as on the Mac).
#[tauri::command]
pub fn restart_relo(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = restart_helper_args(std::process::id(), &exe.to_string_lossy());
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("could not prepare the restart: {e}"))?;
    crate::quit::request(&app);
    Ok(())
}

// ---- Launch timing (Mac: LocalMode.swift "launch: first notch draw after N ms") ----

static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static MARKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Called first thing in `main`.
pub fn mark_process_start() {
    let _ = STARTED.set(Instant::now());
}

/// The log line for a stage reached `ms` after the process started; None for a stage that is not one of ours.
pub fn launch_line(stage: &str, ms: u128) -> Option<String> {
    let what = match stage {
        "windowShown" => "notch window shown",
        "firstDraw" => "first notch draw",
        "liveData" => "live data",
        _ => return None,
    };
    Some(format!("launch: {what} after {ms} ms"))
}

/// Logs a launch stage once: `windowShown` (Rust), `firstDraw` (the page finished loading) and `liveData` (the page's first
/// live Now) — the page calls `launchMark`.
pub fn log_launch(stage: &str) {
    let Some(started) = STARTED.get() else { return };
    let Some(line) = launch_line(stage, started.elapsed().as_millis()) else { return };
    {
        let mut done = MARKED.lock().unwrap();
        if done.iter().any(|s| s == stage) {
            return;
        }
        done.push(stage.to_string());
    }
    crate::services::log_event("info".into(), line);
}

#[tauri::command]
pub fn launch_mark(stage: String) {
    log_launch(&stage);
}

/// The Windows Task Scheduler (`taskschd.msc`), where the owner sees and edits Relo's scheduled tasks (L17).
#[tauri::command]
pub fn open_task_scheduler() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("mmc.exe")
            .arg("taskschd.msc")
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open Task Scheduler: {e}"))
    }
    #[cfg(not(windows))]
    Err("Task Scheduler is a Windows tool".into())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = launch::validate_open_url(&url).ok_or("only https URLs can be opened")?;
    shell_open(&url)
}

#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe { ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("could not open the browser (code {})", r.0 as isize)) }
}

#[tauri::command]
pub fn launch_args() -> launch::Launch {
    let args: Vec<String> = std::env::args().collect();
    launch::parse_launch(&args)
}

/// The server the installer came from (`%LOCALAPPDATA%\Relo\install-source.json`), for when the app was started without
/// `--relo-origin`; the onboarding pre-fills it. None in a dev build or without a valid record.
#[tauri::command]
pub fn install_source() -> Option<String> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    launch::install_source(std::path::Path::new(&local), crate::profile::DEV)
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    secrets::get(&secrets::WinCredStore, &name)
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    secrets::set(&secrets::WinCredStore, &name, &value)
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    secrets::delete(&secrets::WinCredStore, &name)
}

#[tauri::command]
pub fn autostart_get() -> Result<bool, String> {
    autostart::is_enabled(&autostart::RegistryRunKey)
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    autostart::set_enabled(&autostart::RegistryRunKey, &exe.to_string_lossy(), enabled)
}

/// Gives the process the AppUserModelID the installer stamps on Relo's Start menu shortcut, so the taskbar, Alt-Tab and
/// notifications show Relo's name and icon and a pinned Relo matches the running one. Best effort: a failure leaves the
/// exe's own icon.
#[cfg(windows)]
pub fn set_app_user_model_id(id: &str) {
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::PCWSTR(wide.as_ptr()));
    }
}
