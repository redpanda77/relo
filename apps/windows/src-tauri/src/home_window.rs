//! The Home window (label `home`, declared hidden in tauri.conf.json): Relo's main window, as on the Mac
//! (ReloHomeWindowController, 1060x700, min 780x520). It has no owner client of its own. The notch page owns the
//! connection and publishes what Home shows with `home_publish` (a JSON object, see src/home/state.ts); Rust keeps
//! the latest one so Home paints at once when it opens, and relays changes as `home_state`.
//!
//! Home's buttons go back through Rust: "Open in Notch" emits `shortcut` {action:"openNotch"} to the notch, and
//! the Dashboard button emits `tray_action` {action:"open_dashboard"} (the notch already handles that one).

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const MAX_STATE_BYTES: usize = 512 * 1024;

static LATEST: Mutex<Option<Value>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct Action {
    action: &'static str,
}

/// A published state must be a JSON object of sane size.
pub fn valid_state(v: &Value) -> Result<(), String> {
    if !v.is_object() {
        return Err("the Home state must be a JSON object".into());
    }
    if v.to_string().len() > MAX_STATE_BYTES {
        return Err("the Home state is too large".into());
    }
    Ok(())
}

pub fn open(app: &AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("home").ok_or("the Home window is missing")?;
    let _ = w.unminimize();
    crate::chrome::show(&w).map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub fn open_home(app: AppHandle) -> Result<(), String> {
    open(&app)
}

#[tauri::command]
pub fn close_home(app: AppHandle) {
    if let Some(w) = app.get_webview_window("home") {
        crate::chrome::hide(&w);
    }
}

/// The notch page publishes the state Home shows.
#[tauri::command]
pub fn home_publish(app: AppHandle, state: Value) -> Result<(), String> {
    valid_state(&state)?;
    *LATEST.lock().unwrap() = Some(state.clone());
    let _ = app.emit_to("home", "home_state", state);
    Ok(())
}

/// The latest published state, for a Home page that loaded after it was published.
#[tauri::command]
pub fn home_state_get() -> Option<Value> {
    LATEST.lock().unwrap().clone()
}

/// "Open in Notch" (hint Ctrl+Shift+I).
#[tauri::command]
pub fn home_open_notch(app: AppHandle) {
    let _ = app.emit_to("notch", "shortcut", Action { action: "openNotch" });
}

/// The Dashboard icon: the notch owns the server address, so it opens the page.
#[tauri::command]
pub fn home_open_dashboard(app: AppHandle) {
    let _ = app.emit_to("notch", "tray_action", Action { action: "open_dashboard" });
}

// ---- Frame persistence (Mac: the Home window's frame autosave) ----

/// Position and size in physical pixels, plus the maximized state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

const MIN_W: u32 = 780;
const MIN_H: u32 = 520;

/// A saved frame made safe for the current monitors (`monitors` are (x, y, w, h)): at least the minimum size, no larger
/// than the monitor it mostly sits on, and moved fully onto it. None when it is on no monitor at all (unplugged display):
/// the window then opens centred as before.
pub fn fit_frame(f: Frame, monitors: &[(i32, i32, u32, u32)]) -> Option<Frame> {
    let overlap = |m: &(i32, i32, u32, u32)| {
        let w = (f.x + f.w as i32).min(m.0 + m.2 as i32) - f.x.max(m.0);
        let h = (f.y + f.h as i32).min(m.1 + m.3 as i32) - f.y.max(m.1);
        if w > 0 && h > 0 { w as i64 * h as i64 } else { 0 }
    };
    let m = monitors.iter().max_by_key(|m| overlap(m)).filter(|m| overlap(m) > 0)?;
    let w = f.w.max(MIN_W).min(m.2);
    let h = f.h.max(MIN_H).min(m.3);
    let x = f.x.clamp(m.0, m.0 + m.2 as i32 - w as i32);
    let y = f.y.clamp(m.1, m.1 + m.3 as i32 - h as i32);
    Some(Frame { x, y, w, h, maximized: f.maximized })
}

fn frame_path() -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(std::env::var_os("APPDATA")?).join(crate::profile::app_dir()).join("home-window.json"))
}

fn load_frame() -> Option<Frame> {
    serde_json::from_slice(&std::fs::read(frame_path()?).ok()?).ok()
}

fn save_frame(f: &Frame) {
    let Some(p) = frame_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(f) {
        let _ = std::fs::write(p, bytes);
    }
}

fn current_frame(w: &tauri::WebviewWindow) -> Option<Frame> {
    let maximized = w.is_maximized().unwrap_or(false);
    // A maximized window reports the maximized rect: keep the last normal frame instead.
    if maximized {
        return load_frame().map(|f| Frame { maximized: true, ..f });
    }
    let (p, s) = (w.outer_position().ok()?, w.inner_size().ok()?);
    Some(Frame { x: p.x, y: p.y, w: s.width, h: s.height, maximized: false })
}

fn restore_frame(w: &tauri::WebviewWindow) {
    let Some(saved) = load_frame() else { return };
    let monitors: Vec<_> = w
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect();
    let Some(f) = fit_frame(saved, &monitors) else { return };
    let _ = w.set_size(tauri::PhysicalSize::new(f.w, f.h));
    let _ = w.set_position(tauri::PhysicalPosition::new(f.x, f.y));
    if f.maximized {
        let _ = w.maximize();
    }
}

/// Call once from setup: closing hides the window (it keeps its state and reopens at once), and its frame is saved when it
/// moves or resizes and restored here.
pub fn init(app: &AppHandle) {
    let Some(w) = app.get_webview_window("home") else { return };
    // No native title band: the page draws its own title area (src/chrome/TitleBar.tsx).
    crate::chrome::apply_custom_chrome(&w);
    restore_frame(&w);
    let hide = w.clone();
    w.on_window_event(move |ev| match ev {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(f) = current_frame(&hide) {
                save_frame(&f);
            }
            crate::chrome::hide(&hide);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if hide.is_visible().unwrap_or(false) && !hide.is_minimized().unwrap_or(false) {
                if let Some(f) = current_frame(&hide) {
                    save_frame(&f);
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_objects_only() {
        assert!(valid_state(&json!({"connection": "live"})).is_ok());
        assert!(valid_state(&json!([1])).is_err());
        assert!(valid_state(&json!("x")).is_err());
    }

    const MONS: [(i32, i32, u32, u32); 2] = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)];

    #[test]
    fn a_saved_frame_is_kept_when_it_fits_and_pulled_onto_the_screen_when_it_does_not() {
        let ok = Frame { x: 100, y: 80, w: 1060, h: 700, maximized: false };
        assert_eq!(fit_frame(ok, &MONS), Some(ok));
        // hanging off the right edge of the second monitor
        let off = Frame { x: 4000, y: 900, w: 1060, h: 700, maximized: true };
        assert_eq!(fit_frame(off, &MONS), Some(Frame { x: 3420, y: 740, w: 1060, h: 700, maximized: true }));
        // smaller than the minimum, larger than the monitor
        let tiny = Frame { x: 10, y: 10, w: 100, h: 100, maximized: false };
        assert_eq!(fit_frame(tiny, &MONS).map(|f| (f.w, f.h)), Some((780, 520)));
        let huge = Frame { x: 0, y: 0, w: 5000, h: 5000, maximized: false };
        assert_eq!(fit_frame(huge, &MONS).map(|f| (f.w, f.h)), Some((2560, 1440))); // the monitor it overlaps most
    }

    #[test]
    fn a_frame_on_an_unplugged_display_is_dropped() {
        let gone = Frame { x: 6000, y: 0, w: 1060, h: 700, maximized: false };
        assert_eq!(fit_frame(gone, &MONS), None);
        assert_eq!(fit_frame(gone, &[]), None);
    }

    #[test]
    fn refuses_oversize() {
        assert!(valid_state(&json!({"x": "a".repeat(MAX_STATE_BYTES)})).is_err());
    }
}
