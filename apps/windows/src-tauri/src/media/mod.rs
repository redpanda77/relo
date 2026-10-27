//! Music for Relo on Windows (the Mac's MusicManager + MediaControllers + visualizer + lyrics).
//!
//! - `smtc`: Windows media sessions, event driven (Now Playing, Spotify, Apple Music).
//! - `ytm`: the YouTube Music desktop app's local API (the Mac's YouTubeMusicController).
//! - `loopback` + `fft`: the five-band visualizer from WASAPI loopback, only while the page asks.
//! - `lyrics`: LRCLIB, cached.
//! The hub merges the chosen source into one `MediaState`, and emits `media_state` only when its content changed.
//! Events: `media_state` (MediaState), `media_bands` ([f32; 5]), `media_settings_changed` (Value).

pub mod fft;
pub mod lyrics;
pub mod model;
pub mod ytm;
#[cfg(windows)]
mod loopback;
#[cfg(windows)]
mod smtc;

use model::*;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

struct Hub {
    source: Source,
    smtc: MediaState,
    ytm: Option<MediaState>,
    last: Option<MediaState>,
}

static HUB: Mutex<Hub> = Mutex::new(Hub { source: Source::NowPlaying, smtc: new_state(), ytm: None, last: None });

const fn new_state() -> MediaState {
    MediaState {
        active: false,
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        is_playing: false,
        position_ms: 0,
        duration_ms: 0,
        timestamp_ms: 0,
        rate: 1.0,
        is_shuffled: false,
        repeat: Repeat::Off,
        can_seek: false,
        can_prev: false,
        can_next: false,
        shuffle_supported: false,
        repeat_supported: false,
        volume_supported: false,
        volume: 0.0,
        favorite_supported: false,
        is_favorite: false,
        app_id: String::new(),
        app_name: String::new(),
        artwork: None,
        sessions: Vec::new(),
    }
}

pub fn source() -> Source {
    HUB.lock().unwrap().source
}

fn view(h: &Hub) -> MediaState {
    match h.source {
        Source::YoutubeMusic => {
            let mut s = h.ytm.clone().unwrap_or_default();
            s.sessions = h.smtc.sessions.clone();
            s
        }
        _ => h.smtc.clone(),
    }
}

/// Emit if the visible content changed since the last emit (a moved clock alone is not news).
fn publish(app: &AppHandle) {
    let mut h = HUB.lock().unwrap();
    let now = view(&h);
    if h.last.as_ref().is_some_and(|l| l.same_content(&now)) {
        return;
    }
    h.last = Some(now.clone());
    drop(h);
    let _ = app.emit("media_state", &now);
}

#[cfg(windows)]
pub(crate) fn set_smtc(app: &AppHandle, s: MediaState) {
    HUB.lock().unwrap().smtc = s;
    publish(app);
}

// ---- YouTube Music poller: awake only while that source is chosen ----

static YTM_WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn ytm_wake() {
    YTM_WAKE.1.notify_all();
}

fn spawn_ytm(app: AppHandle) {
    std::thread::Builder::new()
        .name("relo-media-ytm".into())
        .spawn(move || loop {
            // Park until the source is YouTube Music.
            while source() != Source::YoutubeMusic {
                let g = YTM_WAKE.0.lock().unwrap();
                let _ = YTM_WAKE.1.wait_timeout(g, Duration::from_secs(3600));
            }
            let wait = match ytm::poll() {
                Ok(s) => {
                    HUB.lock().unwrap().ytm = Some(s);
                    2
                }
                Err(_) => {
                    HUB.lock().unwrap().ytm = None;
                    8
                }
            };
            publish(&app);
            let g = YTM_WAKE.0.lock().unwrap();
            let _ = YTM_WAKE.1.wait_timeout(g, Duration::from_secs(wait));
        })
        .ok();
}

#[cfg(windows)]
static TX: Mutex<Option<std::sync::mpsc::Sender<smtc::Msg>>> = Mutex::new(None);

/// Start the media machinery with the saved source.
pub fn start(app: &AppHandle) {
    let saved = read_settings();
    HUB.lock().unwrap().source = Source::parse(saved.get("source").and_then(Value::as_str).unwrap_or(""));
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        *TX.lock().unwrap() = Some(tx.clone());
        smtc::spawn(app.clone(), tx, rx);
    }
    spawn_ytm(app.clone());
}

// ---- Settings (%APPDATA%\Relo\media.json; the page owns the schema, Rust reads `source`) ----

fn settings_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(base).join(crate::profile::app_dir()).join("media.json"))
}

fn read_settings() -> Value {
    match settings_path() {
        Ok(p) => crate::settings_window::read_file(&p),
        Err(_) => serde_json::json!({}),
    }
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn media_settings_read() -> Value {
    read_settings()
}

/// Replaces the file, applies a changed source at once, and tells every window.
#[tauri::command]
pub fn media_settings_write(app: AppHandle, settings: Value) -> Result<(), String> {
    let _g = WRITE_LOCK.lock().unwrap();
    crate::settings_window::write_file(&settings_path()?, &settings)?;
    let src = Source::parse(settings.get("source").and_then(Value::as_str).unwrap_or(""));
    let changed = {
        let mut h = HUB.lock().unwrap();
        let c = h.source != src;
        h.source = src;
        h.last = None;
        c
    };
    if changed {
        refresh();
        ytm_wake();
        publish(&app);
    }
    let _ = app.emit("media_settings_changed", &settings);
    Ok(())
}

fn refresh() {
    #[cfg(windows)]
    if let Some(tx) = TX.lock().unwrap().as_ref() {
        let _ = tx.send(smtc::Msg::Sessions);
    }
}

// ---- Commands ----

#[tauri::command]
pub fn media_get() -> MediaState {
    view(&HUB.lock().unwrap())
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Control {
    Toggle,
    Play,
    Pause,
    Next,
    Prev,
    Shuffle,
    Repeat,
    Like,
}

fn control_name(c: Control) -> &'static str {
    match c {
        Control::Toggle => "toggle",
        Control::Play => "play",
        Control::Pause => "pause",
        Control::Next => "next",
        Control::Prev => "prev",
        Control::Shuffle => "shuffle",
        Control::Repeat => "repeat",
        Control::Like => "like",
    }
}

fn after_ytm() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(150));
        ytm_wake();
    });
}

fn send_ytm(name: &'static str, arg: Option<f64>) {
    std::thread::spawn(move || {
        let _ = ytm::command(name, arg);
        after_ytm();
    });
}

#[tauri::command]
pub fn media_control(control: Control) {
    if source() == Source::YoutubeMusic {
        send_ytm(control_name(control), None);
        return;
    }
    #[cfg(windows)]
    {
        use smtc::{Cmd, Msg};
        let cmd = match control {
            Control::Toggle => Cmd::Toggle,
            Control::Play => Cmd::Play,
            Control::Pause => Cmd::Pause,
            Control::Next => Cmd::Next,
            Control::Prev => Cmd::Prev,
            Control::Shuffle => Cmd::Shuffle,
            Control::Repeat => Cmd::Repeat,
            Control::Like => return, // favorites exist only for YouTube Music
        };
        if let Some(tx) = TX.lock().unwrap().as_ref() {
            let _ = tx.send(Msg::Cmd(cmd));
        }
    }
}

#[tauri::command]
pub fn media_seek(seconds: f64) {
    if !seconds.is_finite() {
        return;
    }
    if source() == Source::YoutubeMusic {
        send_ytm("seek", Some(seconds));
        return;
    }
    #[cfg(windows)]
    if let Some(tx) = TX.lock().unwrap().as_ref() {
        let _ = tx.send(smtc::Msg::Cmd(smtc::Cmd::Seek(seconds)));
    }
}

/// Windows media sessions have no volume; YouTube Music's API does.
#[tauri::command]
pub fn media_volume(level: f64) {
    if source() == Source::YoutubeMusic && level.is_finite() {
        send_ytm("volume", Some(level));
    }
}

/// Start or stop the loopback capture behind the visualizer.
#[tauri::command]
pub fn media_visualizer(app: AppHandle, on: bool) {
    #[cfg(windows)]
    loopback::set(&app, on);
    #[cfg(not(windows))]
    let _ = (app, on);
}

#[tauri::command]
pub async fn media_lyrics(title: String, artist: String) -> Option<lyrics::Lyrics> {
    if title.trim().is_empty() || title.len() > 300 || artist.len() > 300 {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || lyrics::fetch(&title, &artist)).await.ok().flatten()
}

fn valid_app_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '!' | '-' | ' '))
}

/// Open the source app (the Mac opens it when you click the cover).
#[tauri::command]
pub fn media_open_app() {
    let id = view(&HUB.lock().unwrap()).app_id;
    if !valid_app_id(&id) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x0800_0000;
        let _ = if id.contains('!') {
            std::process::Command::new("explorer.exe").arg(format!("shell:AppsFolder\\{id}")).creation_flags(NO_WINDOW).spawn()
        } else {
            std::process::Command::new("cmd").args(["/c", "start", "", &id]).creation_flags(NO_WINDOW).spawn()
        };
    }
}

// ---- Full-screen behavior: is the app in front the one playing? ----

/// Does the foreground process `exe` (file name) belong to the session `app_id`?
pub fn exe_matches_app(app_id: &str, exe: &str) -> bool {
    let stem = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_ascii_lowercase();
    let stem = stem.strip_suffix(".exe").unwrap_or(&stem).to_string();
    !stem.is_empty() && app_id.to_ascii_lowercase().contains(&stem)
}

#[tauri::command]
pub fn media_foreground_is_source() -> bool {
    #[cfg(windows)]
    {
        let id = view(&HUB.lock().unwrap()).app_id;
        return foreground_exe().is_some_and(|e| exe_matches_app(&id, &e));
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
fn foreground_exe() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_exe_matches_session_app() {
        assert!(exe_matches_app("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", r"C:\Users\x\AppData\Roaming\Spotify\Spotify.exe"));
        assert!(exe_matches_app("chrome.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
        assert!(!exe_matches_app("chrome.exe", r"C:\Games\game.exe"));
        assert!(!exe_matches_app("chrome.exe", ""));
    }

    #[test]
    fn app_ids_are_validated_before_launching() {
        assert!(valid_app_id("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(valid_app_id("chrome.exe"));
        assert!(!valid_app_id("a&calc"));
        assert!(!valid_app_id(""));
    }
}
