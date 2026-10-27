//! Click and scroll gestures over the notch, reported to the page as `notch_gesture` events. The Mac opens the notch on
//! a click or a trackpad pan down and closes it on a pan up, with a sensitivity setting (ContentView.swift:140,
//! 492-545; extensions/PanGesture.swift; Settings > Gestures 100 high / 200 medium / 300 low). On Windows:
//!
//! * a left click while the pointer is over the notch -> `{kind:"click"}` (the page opens or pins it when closed);
//! * the mouse wheel (or a touchpad two-finger scroll) over the notch is the pan: down accumulates toward
//!   `sensitivity` (one wheel notch is 120, so High opens on the first notch, Medium on the second, Low on the
//!   third), up toward closing. Each wheel event -> `{kind:"scroll", direction, progress 0..1}`, and crossing the
//!   threshold -> `{kind:"open"}` / `{kind:"close"}`. The page applies the Mac's guards (open only when closed; close
//!   only when open and not on the Relo tab, which scrolls its cards).
//!
//! Detection hangs off the pointer loop in main.rs (`on_poll`, called once per tick with "pointer is over the hot
//! rect"); wheel deltas come from a low-level mouse hook thread that only queues them and never blocks or swallows.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const IDLE_RESET: Duration = Duration::from_millis(400);
/// After a trigger, wheel inertia (a touchpad keeps sending deltas) is ignored for this long.
const LOCKOUT: Duration = Duration::from_millis(600);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GestureEvent {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

impl GestureEvent {
    fn bare(kind: &'static str) -> Self {
        Self { kind, direction: None, progress: None }
    }
}

// ---- Pure part (tested) ----

/// A press is the edge from up to down, and only counts while the pointer is over the notch.
#[derive(Default)]
pub struct ClickDetector {
    was_down: bool,
}

impl ClickDetector {
    pub fn update(&mut self, down: bool, inside: bool) -> bool {
        let press = down && !self.was_down;
        self.was_down = down;
        press && inside
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Mac `enableGestures`
    pub enabled: bool,
    /// Mac `closeGestureEnabled`
    pub close_enabled: bool,
    /// Mac `gestureSensitivity`: 100 (high) ... 300 (low)
    pub sensitivity: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true, close_enabled: true, sensitivity: 200.0 }
    }
}

#[derive(Default)]
pub struct Wheel {
    acc: f64,
    last: Option<Instant>,
    locked_until: Option<Instant>,
}

impl Wheel {
    /// One wheel delta (positive = wheel up, negative = down). Returns the events to emit.
    pub fn feed(&mut self, delta: i16, now: Instant, s: Settings) -> Vec<GestureEvent> {
        if !s.enabled || delta == 0 {
            return vec![];
        }
        if self.locked_until.is_some_and(|t| now < t) {
            return vec![];
        }
        let down = delta < 0;
        let idle = self.last.is_none_or(|t| now.duration_since(t) > IDLE_RESET);
        if idle || (self.acc != 0.0 && (self.acc > 0.0) != down) {
            self.acc = 0.0;
        }
        self.last = Some(now);
        self.acc += -(delta as f64); // down is positive from here on, as the Mac's translation
        let travel = self.acc.abs();
        let direction = if down { "down" } else { "up" };
        let threshold = s.sensitivity.max(1.0);
        let mut out = vec![GestureEvent { kind: "scroll", direction: Some(direction), progress: Some((travel / threshold).min(1.0)) }];
        if travel > threshold {
            self.acc = 0.0;
            self.locked_until = Some(now + LOCKOUT);
            if down {
                out.push(GestureEvent::bare("open"));
            } else if s.close_enabled {
                out.push(GestureEvent::bare("close"));
            }
        }
        out
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// ---- State and the poll hook ----

struct State {
    /// Click and wheel trackers per notch window: "notch" and, with "Show on all displays", each mirror (mirrors.rs).
    per: std::collections::HashMap<String, (ClickDetector, Wheel)>,
    settings: Settings,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static DELTAS: Mutex<VecDeque<i16>> = Mutex::new(VecDeque::new());

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().unwrap();
    f(g.get_or_insert_with(|| State { per: Default::default(), settings: Settings::default() }))
}

/// Called by the pointer loop once per tick. `inside` = the pointer is over the notch's hot rect.
pub fn on_poll(app: &AppHandle, inside: bool) {
    on_poll_for(app, "notch", inside);
}

/// `on_poll` for one notch window (`label`). The wheel belongs to the window the pointer is over: only that one drains the
/// queue; the main notch still empties it when the pointer is over no notch at all, so stale turns never replay.
pub fn on_poll_for(app: &AppHandle, label: &str, inside: bool) {
    let take = inside || (label == "notch" && !crate::mirrors::pointer_over_any());
    let deltas: Vec<i16> = if take { DELTAS.lock().unwrap().drain(..).collect() } else { Vec::new() };
    let down = left_button_down();
    let now = Instant::now();
    let events = with_state(|st| {
        let settings = st.settings;
        let (click, wheel) = st.per.entry(label.to_string()).or_default();
        let mut out = Vec::new();
        if click.update(down, inside) {
            out.push(GestureEvent::bare("click"));
        }
        if inside {
            for d in deltas {
                out.extend(wheel.feed(d, now, settings));
            }
        } else {
            wheel.reset();
        }
        out
    });
    for e in events {
        let _ = app.emit_to(label, "notch_gesture", e);
    }
}

/// Mac Settings > Gestures. Call from the settings consumer; defaults are enabled / close enabled / 200.
#[tauri::command]
pub fn gestures_configure(enabled: bool, close_enabled: bool, sensitivity: f64) {
    with_state(|st| st.settings = Settings { enabled, close_enabled, sensitivity: sensitivity.clamp(50.0, 600.0) });
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

/// Install the wheel hook on its own thread (a low-level hook needs a message loop). Call once from setup.
pub fn start() {
    #[cfg(windows)]
    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::*;
        let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) else {
            eprintln!("relo: could not install the wheel hook; scroll gestures are off");
            return;
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    });
}

#[cfg(windows)]
unsafe extern "system" fn mouse_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::*;
    if code >= 0 && wparam.0 as u32 == WM_MOUSEWHEEL {
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let delta = (info.mouseData >> 16) as i16;
        if let Ok(mut q) = DELTAS.try_lock() {
            if q.len() < 64 {
                q.push_back(delta);
            }
        }
    }
    // Never swallow: the wheel keeps working for every app.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64, base: Instant) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn a_click_is_the_press_edge_over_the_notch() {
        let mut c = ClickDetector::default();
        assert!(!c.update(false, true));
        assert!(c.update(true, true));
        assert!(!c.update(true, true)); // held
        assert!(!c.update(false, true));
        assert!(!c.update(true, false)); // pressed elsewhere
        // dragging into the notch with the button held is not a click
        assert!(!c.update(true, true));
    }

    #[test]
    fn scrolling_down_past_the_sensitivity_opens_once() {
        let t = Instant::now();
        let mut w = Wheel::default();
        let s = Settings::default(); // 200: the second notch (240 > 200)
        let first = w.feed(-120, at(0, t), s);
        assert_eq!(first, vec![GestureEvent { kind: "scroll", direction: Some("down"), progress: Some(0.6) }]);
        let second = w.feed(-120, at(100, t), s);
        assert_eq!(second.len(), 2);
        assert_eq!(second[1].kind, "open");
        // inertia right after the trigger is ignored
        assert!(w.feed(-120, at(200, t), s).is_empty());
        // and works again after the lockout
        assert_eq!(w.feed(-120, at(1000, t), s).len(), 1);
    }

    #[test]
    fn high_sensitivity_opens_on_one_notch_and_low_needs_three() {
        let t = Instant::now();
        let hi = Settings { sensitivity: 100.0, ..Settings::default() };
        assert_eq!(Wheel::default().feed(-120, t, hi).last().unwrap().kind, "open");
        let lo = Settings { sensitivity: 300.0, ..Settings::default() };
        let mut w = Wheel::default();
        assert_eq!(w.feed(-120, at(0, t), lo).len(), 1);
        assert_eq!(w.feed(-120, at(50, t), lo).len(), 1);
        assert_eq!(w.feed(-120, at(100, t), lo).last().unwrap().kind, "open");
    }

    #[test]
    fn up_closes_unless_disabled_and_a_pause_or_reversal_restarts() {
        let t = Instant::now();
        let s = Settings { sensitivity: 100.0, ..Settings::default() };
        assert_eq!(Wheel::default().feed(120, t, s).last().unwrap().kind, "close");
        let no_close = Settings { close_enabled: false, ..s };
        assert_eq!(Wheel::default().feed(120, t, no_close).len(), 1);
        let off = Settings { enabled: false, ..s };
        assert!(Wheel::default().feed(-120, t, off).is_empty());
        let mut w = Wheel::default();
        let slow = Settings::default();
        w.feed(-120, at(0, t), slow);
        w.feed(120, at(50, t), slow); // reversal: starts over, 120 up < 200
        let after_pause = w.feed(120, at(700, t), slow); // idle reset: 120 again, not 240
        assert_eq!(after_pause.len(), 1);
    }

    #[test]
    fn progress_is_capped_at_one() {
        let t = Instant::now();
        let s = Settings { enabled: true, close_enabled: false, sensitivity: 100.0 };
        let e = Wheel::default().feed(-480, t, s);
        assert_eq!(e[0].progress, Some(1.0));
    }
}
