//! "Show on all displays": one mirror notch window per extra monitor.
//!
//! Mac source: boringNotchApp.swift `adjustWindowPosition` with `showOnAllDisplays` (one window and view model per screen,
//! windows for screens that went away are closed, the rest repositioned) and BoringViewCoordinator. Here the window labelled
//! `notch` is the only one that talks to the server (the owner client lives in its page). It sits on the primary display;
//! every other display gets a mirror labelled `notch-<monitor>` with the same window config, which renders the state the
//! main notch broadcasts (src/mirror) and sends the owner's actions back. Each mirror has its own hover, click-through,
//! hot rect, gestures and open state: the notch that opens is the one the pointer is on.
//!
//! Mirrors are created and destroyed on a worker thread (building a webview on the main thread from an event handler can
//! deadlock); `request_sync` asks for a pass and the pass reads the current displays itself, so requests coalesce.

use crate::displays::DisplayInfo;
use crate::geometry::{next_inside, placement, poll_interval_ms, Placement, Rect};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WebviewWindowBuilder};

/// Every mirror label starts with this; the main notch is exactly `notch`.
pub const PREFIX: &str = "notch-";

/// One mirror: its window label and the index of the display it sits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub label: String,
    pub display: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub create: Vec<Spec>,
    pub keep: Vec<Spec>,
    pub destroy: Vec<String>,
}

fn sanitize(id: &str) -> String {
    let id = id.trim_start_matches(r"\\.\");
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(48).collect();
    if s.is_empty() { "display".into() } else { s }
}

/// Window label for a display id (`\\.\DISPLAY2` -> `notch-DISPLAY2`). Tauri labels allow letters, digits, `-`, `_`.
pub fn label_for(id: &str) -> String {
    format!("{PREFIX}{}", sanitize(id))
}

/// One label per display, unique even when two ids sanitize alike (a `-<index>` follows the later one).
pub fn labels(displays: &[DisplayInfo]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for (i, d) in displays.iter().enumerate() {
        let mut l = label_for(&d.id);
        if seen.contains(&l) {
            l = format!("{l}-{i}");
        }
        seen.push(l);
    }
    seen
}

pub fn is_mirror(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// What to do so that, with `show_all`, every display except the main notch's (`primary`) has exactly one mirror, and with
/// it off none does. `existing` are the labels of the mirror windows that exist now.
pub fn plan(displays: &[DisplayInfo], primary: Option<usize>, show_all: bool, existing: &[String]) -> Plan {
    let all = labels(displays);
    let wanted: Vec<Spec> = if show_all {
        all.iter().enumerate().filter(|(i, _)| Some(*i) != primary).map(|(i, l)| Spec { label: l.clone(), display: i }).collect()
    } else {
        Vec::new()
    };
    let mut p = Plan::default();
    for s in wanted.iter() {
        if existing.contains(&s.label) { p.keep.push(s.clone()) } else { p.create.push(s.clone()) }
    }
    p.destroy = existing.iter().filter(|e| is_mirror(e) && !wanted.iter().any(|s| &s.label == *e)).cloned().collect();
    p
}

// ---- Runtime ----

static HOT: Mutex<Option<HashMap<String, Rect>>> = Mutex::new(None);
static OVER_ANY: AtomicBool = AtomicBool::new(false);
/// Bumped whenever a mirror is built, so the pointer loop forgets what it applied to a window that was replaced.
static EPOCH: AtomicU64 = AtomicU64::new(0);
static SYNC: OnceLock<Sender<()>> = OnceLock::new();

/// The page of a mirror reports its hot rect (physical px, window-relative), like the main notch's `set_hot`.
pub fn set_hot(label: &str, rect: Rect) {
    HOT.lock().unwrap().get_or_insert_with(Default::default).insert(label.to_string(), rect);
}

/// The pointer is over some mirror (the main notch then leaves the wheel queue alone, see gestures.rs).
pub fn pointer_over_any() -> bool {
    OVER_ANY.load(Ordering::Relaxed)
}

/// Labels of the mirror windows that exist.
pub fn existing(app: &AppHandle) -> Vec<String> {
    let mut v: Vec<String> = app.webview_windows().keys().filter(|l| is_mirror(l)).cloned().collect();
    v.sort();
    v
}

pub fn for_each(app: &AppHandle, f: impl Fn(&WebviewWindow)) {
    for l in existing(app) {
        if let Some(w) = app.get_webview_window(&l) {
            f(&w);
        }
    }
}

/// Send an event to every mirror (fullscreen quiet).
pub fn emit_all<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    for l in existing(app) {
        let _ = app.emit_to(l.as_str(), event, payload.clone());
    }
}

/// Re-stamp the no-focus style and the topmost band of every mirror (the watchdog's job for the main notch).
pub fn restamp(app: &AppHandle) {
    #[cfg(windows)]
    for_each(app, |w| {
        crate::win::stamp_style(w);
        crate::win::raise(w);
    });
    #[cfg(not(windows))]
    let _ = app;
}

/// Ask for a pass that makes the mirror windows match the settings and the displays.
pub fn request_sync() {
    if let Some(tx) = SYNC.get() {
        let _ = tx.send(());
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    if SYNC.set(tx).is_err() {
        return;
    }
    let sync_app = app.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            std::thread::sleep(Duration::from_millis(60));
            while rx.try_recv().is_ok() {}
            sync_now(&sync_app);
        }
    });
    start_pointer_loop(app);
}

fn apply_rect(w: &WebviewWindow, p: Placement) {
    let size = PhysicalSize::new(p.w, p.h);
    let pos = PhysicalPosition::new(p.x, p.y);
    let ok = |w: &WebviewWindow| w.outer_position().ok() == Some(pos) && w.outer_size().ok() == Some(size);
    if ok(w) {
        return;
    }
    // Moving across monitors of different scale makes the OS rescale the window: size, move, then size and move again.
    let _ = w.set_position(pos);
    let _ = w.set_size(size);
    if !ok(w) {
        let _ = w.set_size(size);
        let _ = w.set_position(pos);
    }
}

fn build(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let mut cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "notch")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    cfg.label = label.to_string();
    cfg.drag_drop_enabled = false; // file drops belong to the main notch's shelf
    cfg.visible = false;
    WebviewWindowBuilder::from_config(app, &cfg)?.build()
}

fn sync_now(app: &AppHandle) {
    let displays = crate::displays::list(app);
    let primary = crate::displays::primary_index(&displays);
    let show_all = crate::displays::show_all();
    let have = existing(app);
    let p = plan(&displays, primary, show_all, &have);
    for l in &p.destroy {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.destroy();
        }
        if let Some(m) = HOT.lock().unwrap().as_mut() {
            m.remove(l);
        }
    }
    for s in &p.create {
        let d = &displays[s.display];
        match build(app, &s.label) {
            Ok(w) => {
                EPOCH.fetch_add(1, Ordering::SeqCst);
                #[cfg(windows)]
                crate::win::stamp_style(&w);
                apply_rect(&w, placement(d.x, d.y, d.width, d.height, d.scale));
                let _ = w.set_ignore_cursor_events(true);
                let _ = w.show();
                #[cfg(windows)]
                crate::win::restore(&w);
                eprintln!("relo: notch mirror {} on {}", s.label, d.id);
            }
            Err(e) => eprintln!("relo: could not create mirror {}: {e}", s.label),
        }
    }
    for s in &p.keep {
        let d = &displays[s.display];
        if let Some(w) = app.get_webview_window(&s.label) {
            apply_rect(&w, placement(d.x, d.y, d.width, d.height, d.scale));
            if !w.is_visible().unwrap_or(true) {
                let _ = w.show();
            }
            #[cfg(windows)]
            crate::win::raise(&w);
        }
    }
}

/// Per-window pointer work for the mirrors: the same rules as the main notch's loop (main.rs `start_pointer_loop`).
fn start_pointer_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut states: HashMap<String, (bool, Option<bool>)> = HashMap::new(); // (inside, click-through applied)
        let mut epoch = 0;
        loop {
            let labels = existing(&app);
            if labels.is_empty() {
                OVER_ANY.store(false, Ordering::Relaxed);
                states.clear();
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            if EPOCH.load(Ordering::SeqCst) != epoch {
                epoch = EPOCH.load(Ordering::SeqCst);
                states.clear();
            }
            states.retain(|k, _| labels.contains(k));
            let Ok(cur) = app.cursor_position() else {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            };
            let mut near = false;
            let mut over = false;
            for label in &labels {
                let Some(w) = app.get_webview_window(label) else { continue };
                let (Ok(pos), Ok(sz)) = (w.outer_position(), w.outer_size()) else { continue };
                let scale = w.scale_factor().unwrap_or(1.0);
                let (lx, ly) = (cur.x - pos.x as f64, cur.y - pos.y as f64);
                let win = (sz.width as f64, sz.height as f64);
                near |= lx >= 0.0 && ly >= 0.0 && lx < win.0 && ly < win.1;
                let hot = HOT.lock().unwrap().as_ref().and_then(|m| m.get(label).copied());
                let (inside, applied) = states.entry(label.clone()).or_insert((false, None));
                let now = next_inside(hot, *inside, lx, ly, win, scale);
                if *applied != Some(!now) {
                    let _ = w.set_ignore_cursor_events(!now);
                    *applied = Some(!now);
                }
                if now != *inside {
                    *inside = now;
                    let _ = app.emit_to(label.as_str(), "notch_pointer", now);
                }
                over |= *inside;
                crate::gestures::on_poll_for(&app, label, *inside);
            }
            OVER_ANY.store(over, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(poll_interval_ms(near)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, x: i32) -> DisplayInfo {
        DisplayInfo { id: id.into(), name: id.into(), x, y: 0, width: 1920, height: 1080, scale: 1.0, primary: x == 0 }
    }

    fn three() -> Vec<DisplayInfo> {
        vec![d(r"\\.\DISPLAY1", 0), d(r"\\.\DISPLAY2", 1920), d(r"\\.\DISPLAY3", 3840)]
    }

    #[test]
    fn labels_are_valid_unique_and_prefixed() {
        assert_eq!(label_for(r"\\.\DISPLAY2"), "notch-DISPLAY2");
        assert_eq!(label_for("1920,0"), "notch-1920_0");
        assert_eq!(label_for(""), "notch-display");
        let same = vec![d("A B", 0), d("A_B", 1920)];
        let l = labels(&same);
        assert_eq!(l, vec!["notch-A_B".to_string(), "notch-A_B-1".to_string()]);
        assert!(l.iter().all(|x| is_mirror(x) && x != "notch"));
    }

    #[test]
    fn off_means_no_mirror_and_existing_ones_go() {
        let p = plan(&three(), Some(0), false, &["notch-DISPLAY2".into()]);
        assert!(p.create.is_empty() && p.keep.is_empty());
        assert_eq!(p.destroy, vec!["notch-DISPLAY2".to_string()]);
    }

    #[test]
    fn on_gives_every_display_but_the_main_notchs_one_mirror() {
        let p = plan(&three(), Some(0), true, &[]);
        assert_eq!(p.create, vec![Spec { label: "notch-DISPLAY2".into(), display: 1 }, Spec { label: "notch-DISPLAY3".into(), display: 2 }]);
        assert!(p.keep.is_empty() && p.destroy.is_empty());
    }

    #[test]
    fn a_second_pass_changes_nothing() {
        let p = plan(&three(), Some(0), true, &["notch-DISPLAY2".into(), "notch-DISPLAY3".into()]);
        assert!(p.create.is_empty() && p.destroy.is_empty());
        assert_eq!(p.keep.len(), 2);
    }

    #[test]
    fn unplugging_a_display_destroys_its_mirror_and_plugging_one_creates_it() {
        let mut ds = three();
        let have = vec!["notch-DISPLAY2".to_string(), "notch-DISPLAY3".to_string()];
        let removed = ds.pop();
        assert!(removed.is_some());
        let p = plan(&ds, Some(0), true, &have);
        assert_eq!(p.destroy, vec!["notch-DISPLAY3".to_string()]);
        assert_eq!(p.keep.len(), 1);
        ds.push(d(r"\\.\DISPLAY4", 3840));
        let p = plan(&ds, Some(0), true, &["notch-DISPLAY2".into()]);
        assert_eq!(p.create, vec![Spec { label: "notch-DISPLAY4".into(), display: 2 }]);
    }

    #[test]
    fn when_the_main_notch_moves_its_old_display_gets_a_mirror_and_the_new_one_loses_it() {
        let p = plan(&three(), Some(1), true, &["notch-DISPLAY2".into(), "notch-DISPLAY3".into()]);
        assert_eq!(p.create, vec![Spec { label: "notch-DISPLAY1".into(), display: 0 }]);
        assert_eq!(p.destroy, vec!["notch-DISPLAY2".to_string()]);
    }

    #[test]
    fn the_main_notch_is_never_destroyed_and_no_display_means_no_mirror() {
        let p = plan(&three(), Some(0), false, &["notch".into()]);
        assert!(p.destroy.is_empty());
        let p = plan(&[], None, true, &["notch-DISPLAY2".into()]);
        assert_eq!(p.destroy.len(), 1);
    }
}
