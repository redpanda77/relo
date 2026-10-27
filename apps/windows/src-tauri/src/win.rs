//! Win32 window behaviour: never take focus, stay topmost.
//!
//! Adapted in approach from codenotch's topmost.rs (MIT, Copyright (c) 2026 Vinz,
//! https://github.com/vinzdg/codenotch); see apps/windows/THIRD_PARTY.md. Nectar (GPL) was not copied.
//!
//! tao only calls SetWindowPos when its own always-on-top flag flips, so `set_always_on_top(true)` after
//! creation is a no-op. We re-assert HWND_TOPMOST ourselves, without activating.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::*;

const BACKSTOP: Duration = Duration::from_secs(30);

static APP: OnceLock<AppHandle> = OnceLock::new();

/// A text field in the notch is being edited: the window may take the keyboard (WS_EX_NOACTIVATE is off) until it ends.
static KEYBOARD: AtomicBool = AtomicBool::new(false);

/// The HWND is rebuilt from the raw pointer: tauri's `windows` version may differ from ours.
fn hwnd_of(w: &WebviewWindow) -> Option<HWND> {
    w.hwnd().ok().map(|h| HWND(h.0 as _))
}

/// Stamp WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW (no focus steal, no taskbar/Alt-Tab entry).
pub fn stamp_style(w: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(w) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if KEYBOARD.load(Ordering::SeqCst) {
            WS_EX_TOOLWINDOW.0 as isize
        } else {
            (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize
        };
        if ex & want != want {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | want);
        }
    }
}

/// Lets the notch take the keyboard while the owner types in it (the sign-in server field), then gives it back.
/// Only a click in a field turns this on; the window otherwise never takes focus.
pub fn set_keyboard(w: &WebviewWindow, on: bool) {
    KEYBOARD.store(on, Ordering::SeqCst);
    let Some(hwnd) = hwnd_of(w) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if on { ex & !(WS_EX_NOACTIVATE.0 as isize) } else { ex | WS_EX_NOACTIVATE.0 as isize };
        if next != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
    if on {
        let _ = w.set_focus();
    }
}

/// Re-assert the topmost band without moving, sizing or activating.
pub fn raise(w: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(w) else { return };
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// "Hide from screen recording": the window is left out of screenshots, recordings and screen sharing (Windows 10 2004+;
/// older versions show it black, which is the same promise).
pub fn set_capture_excluded(w: &WebviewWindow, on: bool) {
    CAPTURE_EXCLUDED.store(on, Ordering::SeqCst);
    let Some(hwnd) = hwnd_of(w) else { return };
    let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    unsafe {
        let _ = SetWindowDisplayAffinity(hwnd, affinity);
    }
}

/// The wanted "Hide from screen recording" state. The affinity belongs to the HWND, so anything that recreates or
/// re-shows the window (unlock, resume) re-applies it with `reapply_capture` (Mac: `sharingType` set on each new panel).
static CAPTURE_EXCLUDED: AtomicBool = AtomicBool::new(false);

pub fn reapply_capture(w: &WebviewWindow) {
    set_capture_excluded(w, CAPTURE_EXCLUDED.load(Ordering::SeqCst));
}

/// Origin of the monitor that holds the foreground window; the one under the cursor when there is no foreground
/// window. Matches the monitor position tauri reports (the monitor's full rect).
pub fn focus_monitor_origin() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let fg = GetForegroundWindow();
        let mon = if !fg.0.is_null() {
            MonitorFromWindow(fg, MONITOR_DEFAULTTONULL)
        } else {
            let mut p = POINT::default();
            GetCursorPos(&mut p).ok()?;
            MonitorFromPoint(p, MONITOR_DEFAULTTONULL)
        };
        if mon.is_invalid() {
            return None;
        }
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(mon, &mut mi).as_bool().then_some((mi.rcMonitor.left, mi.rcMonitor.top))
    }
}

fn restamp() {
    if let Some(w) = APP.get().and_then(|a| a.get_webview_window("notch")) {
        stamp_style(&w);
        raise(&w);
    }
    if let Some(a) = APP.get() {
        crate::mirrors::restamp(a); // MIRRORS
    }
}

/// After the notch window was hidden or the session changed: style, z-order and capture exclusion all over again.
pub fn restore(w: &WebviewWindow) {
    stamp_style(w);
    reapply_capture(w);
    raise(w);
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    restamp();
    crate::fullscreen::signal();
    crate::displays::signal_follow();
}

/// EVENT_SYSTEM_FOREGROUND hook (the normal moment another app reshuffles z-order) plus a 30 s backstop
/// for a topmost window that appears without becoming foreground.
pub fn start_topmost_watchdog(app: AppHandle) {
    let _ = APP.set(app);
    restamp();

    std::thread::spawn(|| unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None::<HMODULE>,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_invalid() {
            eprintln!("relo: could not install the foreground hook; relying on the 30s backstop");
            return;
        }
        // WINEVENT_OUTOFCONTEXT delivers through this thread's message queue.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            DispatchMessageW(&msg);
        }
        let _ = UnhookWinEvent(hook);
    });

    std::thread::spawn(|| loop {
        std::thread::sleep(BACKSTOP);
        restamp();
        crate::fullscreen::signal();
    });
}
