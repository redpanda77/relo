//! The Settings / onboarding window (label `settings`, declared hidden in tauri.conf.json), the persisted settings
//! file (%APPDATA%\Relo\settings.json, written atomically and broadcast as `settings_changed`) and the two `relo`
//! CLI calls onboarding needs (agent detection and per-agent setup). The CLI is run by absolute path from
//! %LOCALAPPDATA%\Relo\bin\relo.cmd, or the bundled Node and CLI before that file exists (cli_setup.rs `resolve_relo`),
//! with no shell, no console window and validated arguments.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager, WindowEvent};

/// Settings pages the window knows (plus `onboarding`, the first-run flow).
pub const PAGES: [&str; 11] = ["relo", "alerts", "voice", "general", "appearance", "media", "shelf", "shortcuts", "advanced", "about", "onboarding"];
const MAX_SETTINGS_BYTES: usize = 256 * 1024;

pub fn valid_page(page: &str) -> bool {
    PAGES.contains(&page)
}

/// Agent ids come from `relo setup --show` and go onto a command line: lowercase letters, digits and dashes only.
pub fn valid_agent_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

// ---- The settings file ----

fn settings_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(base).join(crate::profile::app_dir()).join("settings.json"))
}

/// Missing or unreadable-as-JSON file: an empty object (defaults apply); a corrupt file is set aside, not lost.
pub fn read_file(path: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(path) else { return json!({}) };
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            json!({})
        }
    }
}

/// Write to a temp file in the same folder, flush it to disk, then rename over the target.
pub fn write_file(path: &Path, value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("settings must be a JSON object".into());
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if text.len() > MAX_SETTINGS_BYTES {
        return Err("settings are too large".into());
    }
    let dir = path.parent().ok_or("bad settings path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn settings_read() -> Result<Value, String> {
    Ok(read_file(&settings_path()?))
}

/// Replaces the whole file, applies what Rust consumes (see `Wanted`), then tells every window.
#[tauri::command]
pub fn settings_write(app: AppHandle, settings: Value) -> Result<(), String> {
    let _g = WRITE_LOCK.lock().unwrap();
    write_file(&settings_path()?, &settings)?;
    apply(&app, &settings, false);
    let _ = app.emit("settings_changed", &settings);
    Ok(())
}

// ---- What Rust consumes ----

/// The settings Rust applies itself (the page only stores them): at launch and on every write that changes one.
/// tray: "Show tray icon". display: the preferred display (None = primary). gestures: enabled, close gesture, sensitivity.
/// shortcuts: the saved bindings (registered by shortcuts.rs). engine: the voice engine. hide_capture: exclude the notch
/// from screen capture.
#[derive(Clone, Debug, PartialEq)]
pub struct Wanted {
    pub tray: bool,
    pub display: Option<String>,
    pub gestures: (bool, bool, i64),
    pub shortcuts: HashMap<String, String>,
    pub engine: String,
    pub hide_capture: bool,
    /// `autoSwitchDisplay` (default on): follow the display that holds the foreground window.
    pub auto_switch: bool,
    /// `showOnLockScreen` (default off): keep the notch's content up while the session is locked.
    pub show_on_lock: bool,
    /// `showOnAllDisplays` (default off): a mirror notch on every display but the main one.
    pub show_all: bool,
}

/// The first launch has not finished onboarding (`onboardingDone` is not true in the settings file).
pub fn onboarding_done() -> bool {
    settings_path().map(|p| read_file(&p)).is_ok_and(|f| f.get("onboardingDone") == Some(&json!(true)))
}

pub fn wanted(settings: &Value) -> Wanted {
    let flag = |key: &str, default: bool| settings.get(key).and_then(Value::as_bool).unwrap_or(default);
    let display = settings.get("display").and_then(Value::as_str).filter(|d| !d.is_empty() && d.len() <= 128).map(String::from);
    let sensitivity = settings
        .get("gestureSensitivity")
        .and_then(Value::as_f64)
        .map(|v| ((v / 100.0).round() as i64 * 100).clamp(100, 300))
        .unwrap_or(200);
    Wanted {
        tray: flag("showTrayIcon", true),
        display,
        gestures: (flag("enableGestures", true), flag("closeGesture", true), sensitivity),
        shortcuts: crate::shortcuts::saved_map(settings),
        engine: if settings.get("voiceEngine").and_then(Value::as_str) == Some("system") { "system".into() } else { "relo".into() },
        hide_capture: flag("hideFromScreenRecording", false),
        auto_switch: flag("autoSwitchDisplay", true),
        show_on_lock: flag("showOnLockScreen", false),
        show_all: flag("showOnAllDisplays", false),
    }
}

/// Which parts of `Wanted` differ (all of them with no previous state).
#[derive(Debug, PartialEq, Eq, Default)]
pub struct Changes {
    pub tray: bool,
    pub display: bool,
    pub gestures: bool,
    pub shortcuts: bool,
    pub engine: bool,
    pub hide_capture: bool,
    pub auto_switch: bool,
    pub show_on_lock: bool,
    pub show_all: bool,
}

pub fn changes(prev: Option<&Wanted>, next: &Wanted) -> Changes {
    let Some(p) = prev else {
        return Changes { tray: true, display: true, gestures: true, shortcuts: true, engine: true, hide_capture: true, auto_switch: true, show_on_lock: true, show_all: true };
    };
    Changes {
        tray: p.tray != next.tray,
        display: p.display != next.display,
        gestures: p.gestures != next.gestures,
        shortcuts: p.shortcuts != next.shortcuts,
        engine: p.engine != next.engine,
        hide_capture: p.hide_capture != next.hide_capture,
        auto_switch: p.auto_switch != next.auto_switch,
        show_on_lock: p.show_on_lock != next.show_on_lock,
        show_all: p.show_all != next.show_all,
    }
}

static APPLIED: Mutex<Option<Wanted>> = Mutex::new(None);

/// Applies what changed since the last call. At launch (`startup`) the shortcuts are left to `shortcuts::init`, which
/// reads the same file after this.
fn apply(app: &AppHandle, settings: &Value, startup: bool) {
    let next = wanted(settings);
    let mut last = APPLIED.lock().unwrap();
    let c = changes(last.as_ref(), &next);
    if c.tray {
        apply_tray_visible(app, next.tray);
    }
    if c.auto_switch {
        crate::displays::set_auto_switch(next.auto_switch);
    }
    if c.show_on_lock {
        crate::session::set_show_on_lock(next.show_on_lock);
    }
    if c.show_all {
        crate::displays::set_show_all(app, next.show_all);
    }
    if c.display {
        let _ = crate::displays::set_display(app.clone(), next.display.clone());
    }
    if c.gestures {
        crate::gestures::gestures_configure(next.gestures.0, next.gestures.1, next.gestures.2 as f64);
    }
    if c.shortcuts && !startup {
        crate::shortcuts::sync(app, &next.shortcuts);
    }
    if c.engine {
        if let (Some(v), Some(e)) = (app.try_state::<crate::voice::VoiceHandle>(), crate::voice::service::Engine::parse(&next.engine)) {
            v.0.set_engine(e);
        }
    }
    if c.hide_capture {
        #[cfg(windows)]
        if let Some(w) = app.get_webview_window("notch") {
            crate::win::set_capture_excluded(&w, next.hide_capture);
        }
        #[cfg(windows)]
        crate::mirrors::for_each(app, |m| crate::win::set_capture_excluded(m, next.hide_capture));
    }
    *last = Some(next);
}

// ---- Facts for the Relo page ----

static OWNER_STATE: Mutex<Option<Value>> = Mutex::new(None);

/// The last `owner_state` the notch reported (the window may open after it), or null.
#[tauri::command]
pub fn owner_state_get() -> Value {
    OWNER_STATE.lock().unwrap().clone().unwrap_or(Value::Null)
}

#[tauri::command]
pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "This PC".into())
}

// ---- The window ----

static PENDING_PAGE: Mutex<Option<String>> = Mutex::new(None);

pub fn open(app: &AppHandle, page: Option<String>) -> Result<(), String> {
    let w = app.get_webview_window("settings").ok_or("the settings window is missing")?;
    if let Some(p) = page {
        if !valid_page(&p) {
            return Err(format!("unknown settings page: {p}"));
        }
        *PENDING_PAGE.lock().unwrap() = Some(p.clone());
        let _ = app.emit_to("settings", "settings_page", p);
    }
    let _ = w.unminimize();
    crate::chrome::show(&w).map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub fn open_settings(app: AppHandle, page: Option<String>) -> Result<(), String> {
    open(&app, page)
}

/// The page asked for before the window's script was listening (taken once).
#[tauri::command]
pub fn settings_page_take() -> Option<String> {
    PENDING_PAGE.lock().unwrap().take()
}

/// Call once from setup: closing hides the window (it keeps its state and reopens at once), and a first
/// launch (no `onboardingDone`) opens the onboarding.
pub fn init(app: &AppHandle) {
    let Some(w) = app.get_webview_window("settings") else { return };
    crate::chrome::apply_custom_chrome(&w);
    let hide = w.clone();
    w.on_window_event(move |ev| {
        if let WindowEvent::CloseRequested { api, .. } = ev {
            api.prevent_close();
            crate::chrome::hide(&hide);
        }
    });
    let file = settings_path().map(|p| read_file(&p)).unwrap_or_else(|_| json!({}));
    apply(app, &file, true);
    app.listen("owner_state", |ev| {
        if let Ok(v) = serde_json::from_str::<Value>(ev.payload()) {
            *OWNER_STATE.lock().unwrap() = Some(v);
        }
    });
    if file.get("onboardingDone") != Some(&json!(true)) {
        let _ = open(app, Some("onboarding".into()));
    }
}

#[tauri::command]
pub fn hide_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        crate::chrome::hide(&w);
    }
}

#[tauri::command]
pub fn quit_relo(app: AppHandle) {
    crate::quit::request(&app);
}

/// "Show tray icon" (Settings > General).
#[tauri::command]
pub fn set_tray_visible(app: AppHandle, visible: bool) {
    apply_tray_visible(&app, visible);
}

fn apply_tray_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(t) = handle.tray_by_id("main") {
            let _ = t.set_visible(visible);
        }
    });
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is not set")?;
    let dir = PathBuf::from(base).join(crate::profile::app_dir()).join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut c = Command::new("explorer.exe");
    c.arg(&dir);
    no_window(&mut c);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---- The relo CLI ----

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Debug)]
pub struct SetupResult {
    pub ok: bool,
    pub message: String,
}

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = c;
}

/// What runs `relo` (cli_setup.rs `resolve_relo`): relo.cmd when it exists, else the bundled Node and CLI, so the agents
/// step works on an app that was downloaded and has not written the command yet.
fn relo_program() -> Option<(PathBuf, Vec<String>)> {
    let paths = crate::local::paths::Paths::from_env()?;
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let payload = crate::local::paths::find_payload(std::env::var_os(crate::local::paths::PAYLOAD_ENV).as_deref(), exe_dir.as_deref());
    crate::cli_setup::resolve_relo(&paths, payload.as_ref())
}

/// Run the CLI with fixed argument vectors; (exit code, stdout, stderr). Killed at `timeout`.
pub(crate) fn run_relo(args: &[&str], timeout: Duration) -> Result<(i32, String, String), String> {
    let (exe, mut lead) = relo_program().ok_or("relo is not installed")?;
    lead.extend(args.iter().map(|s| s.to_string()));
    let mut c = Command::new(exe);
    c.args(&lead).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break st.code().unwrap_or(-1),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break -2;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    Ok((code, t_out.join().unwrap_or_default(), t_err.join().unwrap_or_default()))
}

fn agent_name(id: &str) -> String {
    match id {
        "claude-code" => "Claude Code",
        "opencode" => "OpenCode",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "gemini" => "Gemini",
        "copilot" => "Copilot",
        "amp" => "Amp",
        "vscode" => "VS Code",
        "claude-desktop" => "Claude Desktop",
        other => return other.to_string(),
    }
    .to_string()
}

/// `relo setup --show --json` prints JSON lines; the one with `harnesses: [{harness}]` lists the agents. Claude Code
/// and OpenCode first, as the Mac does. Ids that fail validation are dropped.
pub fn parse_agents(output: &str) -> Vec<Agent> {
    let mut ids: Vec<String> = Vec::new();
    for line in output.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if let Some(rows) = v.get("harnesses").and_then(Value::as_array) {
            ids = rows.iter().filter_map(|r| r.get("harness")?.as_str()).filter(|s| valid_agent_id(s)).map(String::from).collect();
            if !ids.is_empty() {
                break;
            }
        }
    }
    let first = ["claude-code", "opencode"];
    let mut ordered: Vec<String> = first.iter().filter(|f| ids.iter().any(|i| i == *f)).map(|s| s.to_string()).collect();
    ordered.extend(ids.iter().filter(|i| !first.contains(&i.as_str())).cloned());
    ordered.dedup();
    ordered.into_iter().map(|id| Agent { name: agent_name(&id), id }).collect()
}

/// The agents on this PC; empty when relo is not installed or finds none. Stub for the onboarding.
#[tauri::command]
pub async fn detect_agents() -> Vec<Agent> {
    tauri::async_runtime::spawn_blocking(|| match run_relo(&["setup", "--show", "--json"], Duration::from_secs(30)) {
        Ok((0, out, _)) => parse_agents(&out),
        _ => Vec::new(),
    })
    .await
    .unwrap_or_default()
}

/// `relo setup --agent <id> --json` for one validated agent id.
#[tauri::command]
pub async fn run_setup_agent(agent: String) -> Result<SetupResult, String> {
    if !valid_agent_id(&agent) {
        return Err("invalid agent id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (code, _out, _err) = run_relo(&["setup", "--agent", &agent, "--json"], Duration::from_secs(180))
            .map_err(|_| crate::cli_setup::NO_COMMAND_MESSAGE.to_string())?;
        // Plain words only: the CLI's own output (stack traces, exit codes) never reaches what the owner reads.
        let message = if code == 0 { String::new() } else { crate::cli_setup::agent_failure_message(code, &agent_name(&agent)) };
        Ok(SetupResult { ok: code == 0, message })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-settings-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("settings.json")
    }

    #[test]
    fn missing_file_reads_as_empty_object() {
        assert_eq!(read_file(&tmp("missing")), json!({}));
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp() {
        let p = tmp("rt");
        write_file(&p, &json!({"a": 1, "onboardingDone": true})).unwrap();
        write_file(&p, &json!({"a": 2})).unwrap();
        assert_eq!(read_file(&p), json!({"a": 2}));
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn rejects_non_objects_and_oversize() {
        let p = tmp("bad");
        assert!(write_file(&p, &json!([1])).is_err());
        assert!(write_file(&p, &json!({"x": "a".repeat(MAX_SETTINGS_BYTES)})).is_err());
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let p = tmp("corrupt");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{ nope").unwrap();
        assert_eq!(read_file(&p), json!({}));
        assert!(p.with_extension("json.bad").exists());
    }

    #[test]
    fn agent_ids_and_pages() {
        for ok in ["claude-code", "opencode", "vscode", "a1"] {
            assert!(valid_agent_id(ok), "{ok}");
        }
        for bad in ["", "-x", "Claude", "a b", "a;b", "a&b", "../x", "a\"b", "x".repeat(33).as_str(), "a%b"] {
            assert!(!valid_agent_id(bad), "{bad}");
        }
        assert!(valid_page("voice") && valid_page("onboarding") && valid_page("media") && valid_page("shelf") && !valid_page("nope"));
    }

    #[test]
    fn parses_agents_in_the_macs_order() {
        let out = "noise\n{\"harnesses\":[{\"harness\":\"codex\"},{\"harness\":\"opencode\"},{\"harness\":\"bad id\"},{\"harness\":\"claude-code\"}]}\n";
        let ids: Vec<_> = parse_agents(out).into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["claude-code", "opencode", "codex"]);
        assert_eq!(parse_agents("nothing")[..], []);
    }

    #[test]
    fn pages_are_the_macs_sidebar() {
        for p in ["relo", "alerts", "voice", "general", "appearance", "media", "shelf", "shortcuts", "advanced", "about"] {
            assert!(valid_page(p), "{p}");
        }
    }

    #[test]
    fn wanted_reads_defaults_and_values() {
        let w = wanted(&json!({}));
        assert!(w.tray && !w.hide_capture);
        // keys a store may not have yet: Mac defaults (auto-switch on, show on lock screen off)
        assert!(w.auto_switch && !w.show_on_lock);
        let w2 = wanted(&json!({ "autoSwitchDisplay": false, "showOnLockScreen": true }));
        assert!(!w2.auto_switch && w2.show_on_lock);
        assert!(!w.show_all && wanted(&json!({ "showOnAllDisplays": true })).show_all);
        assert_eq!(w.display, None);
        assert_eq!(w.gestures, (true, true, 200));
        assert_eq!(w.engine, "relo");
        let w = wanted(&json!({"showTrayIcon": false, "display": "DISPLAY2", "enableGestures": false, "gestureSensitivity": 290, "voiceEngine": "system", "hideFromScreenRecording": true, "shortcuts": {"toggleNotchOpen": "Alt+N"}}));
        assert!(!w.tray && w.hide_capture);
        assert_eq!(w.display.as_deref(), Some("DISPLAY2"));
        assert_eq!(w.gestures, (false, true, 300));
        assert_eq!(w.engine, "system");
        assert_eq!(w.shortcuts.get("toggleNotchOpen").map(String::as_str), Some("Alt+N"));
        assert_eq!(wanted(&json!({"display": ""})).display, None);
        assert_eq!(wanted(&json!({"voiceEngine": "windows"})).engine, "relo");
    }

    #[test]
    fn startup_applies_everything_and_a_write_only_what_changed() {
        let a = wanted(&json!({}));
        let all = changes(None, &a);
        assert!(all.tray && all.display && all.gestures && all.shortcuts && all.engine && all.hide_capture && all.auto_switch && all.show_on_lock);
        assert_eq!(changes(Some(&a), &a), Changes::default());
        let b = wanted(&json!({"display": "D2", "closeGesture": false}));
        assert_eq!(changes(Some(&a), &b), Changes { display: true, gestures: true, ..Changes::default() });
        // Unrelated settings (sounds, accent) never change anything here.
        assert_eq!(changes(Some(&a), &wanted(&json!({"sounds": false, "accent": "cyan"}))), Changes::default());
    }
}
