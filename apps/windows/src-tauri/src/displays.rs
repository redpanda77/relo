//! Display choice and placement. Re-places on WM_DISPLAYCHANGE (hidden top-level window: message-only
//! windows do not receive that broadcast) with a slow key-compare poll as backstop.
//!
//! Mac source: boringNotchApp.swift `adjustWindowPosition` (preferred display, else with "Automatically switch displays" the
//! main screen, else any screen) and `recoverWindows` (rebuild now, check again after 1 s and 3 s while displays finish waking).
//! Windows: the "main screen" is the one holding the foreground window (the cursor's when there is none); a foreground
//! change re-evaluates through a debounced worker. `recover` is the retry loop that display changes, wake and unlock share.

use crate::geometry::placement;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// Preferred display id (None = primary). Persisted by the settings layer, which calls `set_display` on start.
static PREFERRED: Mutex<Option<String>> = Mutex::new(None);

/// "Automatically switch displays" (setting `autoSwitchDisplay`, default on as on the Mac): with no preferred display
/// present the notch follows the display that holds the foreground window.
static AUTO_SWITCH: AtomicBool = AtomicBool::new(true);

/// Origin (x, y) of the monitor holding the foreground window, last seen by the follow worker.
static FOCUS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// What the last `place` used: the display list and the notch rect, to skip no-op moves and to notice a stale list.
type Placed = (Vec<DisplayInfo>, (i32, i32, u32, u32));
static PLACED: Mutex<Option<Placed>> = Mutex::new(None);

/// "Show on all displays" (setting `showOnAllDisplays`, default off as on the Mac): the main notch stays on the primary
/// display (no preferred display, no switching) and mirrors.rs puts a mirror notch on every other one.
static SHOW_ALL: AtomicBool = AtomicBool::new(false);

pub fn show_all() -> bool {
    SHOW_ALL.load(Ordering::SeqCst)
}

pub fn set_show_all(app: &AppHandle, on: bool) {
    if SHOW_ALL.swap(on, Ordering::SeqCst) != on {
        place(app);
    }
}

/// Index of the display the main notch sits on now (the same rule `place_if` uses).
pub fn primary_index(displays: &[DisplayInfo]) -> Option<usize> {
    let pref = PREFERRED.lock().unwrap().clone();
    let focus = *FOCUS.lock().unwrap();
    choose_main(pref.as_deref(), AUTO_SWITCH.load(Ordering::SeqCst), focus, show_all(), displays)
}

/// `choose_target`, except that with every display shown the main notch keeps the primary display for good.
pub fn choose_main(preferred: Option<&str>, auto: bool, focus: Option<(i32, i32)>, show_all: bool, displays: &[DisplayInfo]) -> Option<usize> {
    if show_all {
        choose_target(None, false, None, displays)
    } else {
        choose_target(preferred, auto, focus, displays)
    }
}

pub fn set_auto_switch(on: bool) {
    AUTO_SWITCH.store(on, Ordering::SeqCst);
    signal_follow();
}

/// Index of the display to use: the preferred one if present, else the primary, else the first.
#[cfg(test)]
pub fn choose(preferred: Option<&str>, displays: &[DisplayInfo]) -> Option<usize> {
    choose_target(preferred, false, None, displays)
}

/// `choose` with the automatic switch: preferred present wins; else, when `auto`, the display whose origin is `focus`
/// (the monitor of the foreground window); else the primary, else the first.
pub fn choose_target(preferred: Option<&str>, auto: bool, focus: Option<(i32, i32)>, displays: &[DisplayInfo]) -> Option<usize> {
    preferred
        .and_then(|p| displays.iter().position(|d| d.id == p))
        .or_else(|| if auto { focus.and_then(|(x, y)| displays.iter().position(|d| d.x == x && d.y == y)) } else { None })
        .or_else(|| displays.iter().position(|d| d.primary))
        .or(if displays.is_empty() { None } else { Some(0) })
}

pub fn list(app: &AppHandle) -> Vec<DisplayInfo> {
    let Some(w) = app.get_webview_window("notch") else { return vec![] };
    let primary = w.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let mons = w.available_monitors().unwrap_or_default();
    mons.iter()
        .enumerate()
        .map(|(i, m)| {
            let (x, y) = (m.position().x, m.position().y);
            let raw = m.name().cloned().filter(|n| !n.is_empty());
            DisplayInfo {
                id: raw.clone().unwrap_or_else(|| format!("{x},{y}")),
                name: raw.map(|n| format!("{} ({}x{})", n.trim_start_matches(r"\\.\"), m.size().width, m.size().height))
                    .unwrap_or_else(|| format!("Display {}", i + 1)),
                x,
                y,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
                primary: primary == Some((x, y)),
            }
        })
        .collect()
}

pub fn place(app: &AppHandle) {
    place_if(app, true);
}

/// Places the notch; with `force` false a placement identical to the last one is skipped.
fn place_if(app: &AppHandle, force: bool) {
    let Some(w) = app.get_webview_window("notch") else { return };
    let ds = list(app);
    let Some(d) = primary_index(&ds).map(|i| &ds[i]) else { return };
    let p = placement(d.x, d.y, d.width, d.height, d.scale);
    let rect = (p.x, p.y, p.w, p.h);
    {
        let mut last = PLACED.lock().unwrap();
        if !force && last.as_ref().is_some_and(|(l, r)| *r == rect && *l == ds) {
            return;
        }
        *last = Some((ds.clone(), rect));
    }
    let _ = w.set_size(PhysicalSize::new(p.w, p.h));
    let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
    #[cfg(windows)]
    crate::win::raise(&w);
    // Mirror notches (mirrors.rs) follow the same display list.
    crate::mirrors::request_sync();
}

/// True when the display list differs from the one the notch was last placed against.
fn placed_is_stale(app: &AppHandle) -> bool {
    PLACED.lock().unwrap().as_ref().is_none_or(|(l, _)| *l != list(app))
}

static FOLLOW: OnceLock<Sender<()>> = OnceLock::new();

/// A foreground change (or a setting change): ask the follow worker to look at the foreground monitor.
pub fn signal_follow() {
    if let Some(tx) = FOLLOW.get() {
        let _ = tx.send(());
    }
}

fn start_follow(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    let _ = FOLLOW.set(tx);
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // Debounce an alt-tab burst.
            std::thread::sleep(Duration::from_millis(150));
            while rx.try_recv().is_ok() {}
            #[cfg(windows)]
            {
                *FOCUS.lock().unwrap() = crate::win::focus_monitor_origin();
            }
            if AUTO_SWITCH.load(Ordering::SeqCst) && !show_all() {
                place_if(&app, false);
            }
        }
    });
}

static RECOVERY: AtomicU64 = AtomicU64::new(0);

/// Delays (ms) after the first placement at which `recover` looks again: displays finish waking late (Mac: 1 s, 3 s).
pub const RECOVERY_CHECKS_MS: [u64; 2] = [1000, 3000];

/// Put the notch back after a display change, wake or unlock: place now, then check again after 1 s and 3 s and re-place
/// if the display list moved on or the window is not visible. A newer call cancels an older one.
pub fn recover(app: &AppHandle, reason: &'static str) {
    let gen = RECOVERY.fetch_add(1, Ordering::SeqCst) + 1;
    place(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut waited = 0;
        for at in RECOVERY_CHECKS_MS {
            std::thread::sleep(Duration::from_millis(at - waited));
            waited = at;
            if RECOVERY.load(Ordering::SeqCst) != gen || crate::session::locked() {
                return;
            }
            let hidden = app.get_webview_window("notch").is_some_and(|w| !w.is_visible().unwrap_or(true));
            if hidden || placed_is_stale(&app) {
                eprintln!("relo: notch re-placed after {reason} (check at {at} ms)");
                if hidden {
                    if let Some(w) = app.get_webview_window("notch") {
                        let _ = w.show();
                    }
                }
                changed_now(&app);
            }
        }
    });
}

#[tauri::command]
pub fn list_displays(app: AppHandle) -> Vec<DisplayInfo> {
    list(&app)
}

/// `null` = primary. An unknown id is remembered (the display may be plugged in later) and falls back to primary.
#[tauri::command]
pub fn set_display(app: AppHandle, id: Option<String>) -> Result<(), String> {
    if id.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128) {
        return Err("invalid display id".into());
    }
    {
        let mut pref = PREFERRED.lock().unwrap();
        if *pref == id {
            return Ok(());
        }
        *pref = id;
    }
    place(&app);
    Ok(())
}

/// Re-place and tell the page the display list changed.
fn changed_now(app: &AppHandle) {
    place(app);
    let _ = app.emit_to("notch", "displays_changed", list(app));
}

/// A display change: re-place, tell the page, and keep checking while the displays settle.
fn changed(app: &AppHandle) {
    changed_now(app);
    recover(app, "a display change");
}

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    watch::start(app.clone());
    start_follow(app.clone());
    signal_follow();
    // Backstop for changes that send no WM_DISPLAYCHANGE (per-monitor DPI, taskbar moves).
    std::thread::spawn(move || {
        let mut last: Option<Vec<DisplayInfo>> = None;
        loop {
            let now = list(&app);
            if last.as_ref() != Some(&now) {
                if last.is_some() {
                    changed(&app);
                }
                last = Some(now);
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(windows)]
mod watch {
    use super::*;
    use std::sync::OnceLock;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_DISPLAYCHANGE {
            if let Some(app) = APP.get().cloned() {
                // Let tauri's monitor list catch up before reading it.
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(400));
                    changed(&app);
                });
            }
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(h, msg, wp, lp) }
    }

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::spawn(|| unsafe {
            let Ok(inst) = GetModuleHandleW(None) else { return };
            let class = w!("ReloDisplayWatch");
            let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: inst.into(), lpszClassName: class, ..Default::default() };
            if RegisterClassW(&wc) == 0 {
                return;
            }
            // Never shown, never activated: a plain top-level window so the broadcast reaches it.
            let Ok(_hwnd) = CreateWindowExW(WS_EX_TOOLWINDOW, class, w!("Relo display watch"), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else { return };
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                DispatchMessageW(&msg);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, primary: bool) -> DisplayInfo {
        DisplayInfo { id: id.into(), name: id.into(), x: 0, y: 0, width: 1920, height: 1080, scale: 1.0, primary }
    }

    #[test]
    fn prefers_the_chosen_display_then_primary_then_first() {
        let ds = [d("A", false), d("B", true), d("C", false)];
        assert_eq!(choose(Some("C"), &ds), Some(2));
        assert_eq!(choose(None, &ds), Some(1));
        assert_eq!(choose(Some("gone"), &ds), Some(1));
        let none_primary = [d("A", false), d("C", false)];
        assert_eq!(choose(None, &none_primary), Some(0));
        assert_eq!(choose(None, &[]), None);
    }

    fn at(id: &str, x: i32, primary: bool) -> DisplayInfo {
        DisplayInfo { x, ..d(id, primary) }
    }

    #[test]
    fn auto_switch_follows_the_foreground_monitor_unless_a_preferred_display_is_present() {
        let ds = [at("A", 0, true), at("B", 1920, false), at("C", 3840, false)];
        // no preference: the display holding the foreground window
        assert_eq!(choose_target(None, true, Some((1920, 0)), &ds), Some(1));
        // switch off: primary, whatever has focus
        assert_eq!(choose_target(None, false, Some((1920, 0)), &ds), Some(0));
        // a preferred display that is present beats the focus (Mac: preferredScreenUUID first)
        assert_eq!(choose_target(Some("C"), true, Some((1920, 0)), &ds), Some(2));
        // a preferred display that is gone falls through to the focus, then primary
        assert_eq!(choose_target(Some("gone"), true, Some((1920, 0)), &ds), Some(1));
        assert_eq!(choose_target(Some("gone"), false, Some((1920, 0)), &ds), Some(0));
        // focus on an unknown monitor (just unplugged): primary, never nowhere
        assert_eq!(choose_target(None, true, Some((9999, 0)), &ds), Some(0));
        assert_eq!(choose_target(None, true, None, &ds), Some(0));
    }

    #[test]
    fn showing_every_display_pins_the_main_notch_to_the_primary_one() {
        let ds = [at("A", 0, true), at("B", 1920, false)];
        assert_eq!(choose_main(Some("B"), true, Some((1920, 0)), true, &ds), Some(0));
        assert_eq!(choose_main(Some("B"), true, Some((1920, 0)), false, &ds), Some(1));
    }

    #[test]
    fn recovery_checks_after_one_and_three_seconds() {
        assert_eq!(RECOVERY_CHECKS_MS, [1000, 3000]);
    }
}
