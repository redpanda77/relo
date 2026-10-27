//! Session lock, unlock, user switch and power resume.
//!
//! Mac source: boringNotchApp.swift `onScreenLocked` / `onScreenUnlocked` (hide the notch windows unless `showOnLockScreen`,
//! put them back on unlock), `recoverWindows`, and the wake observers (`didWakeNotification` re-reads Now at once;
//! `screensDidWake` / `sessionDidBecomeActive` put the notch back unless the screen is locked).
//!
//! Windows: a hidden top-level window registers for `WTSRegisterSessionNotification` (lock, unlock, console connect) and
//! receives `WM_POWERBROADCAST` (`PBT_APMRESUMEAUTOMATIC`).
//! - Lock: the notch HWND is never hidden (a hidden WebView2 stops painting); instead the page's content is made quiet through
//!   the same `notch_fullscreen` event the fullscreen quiet uses, unless `showOnLockScreen` is on. Windows draws the lock screen
//!   on a separate desktop, so the notch cannot appear over it either way: the setting only decides whether the content is
//!   hidden while the session is locked (the Mac's SkyLight overlay has no Windows counterpart).
//! - Unlock and user switch: style, topmost and capture exclusion are restored and `displays::recover` re-places the notch with
//!   its 1 s and 3 s checks.
//! - Resume, unlock: the page gets `system_resumed` {reason} and refreshes Now at once.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Lock,
    Unlock,
    /// The PC woke from sleep or hibernate.
    Resume,
    /// This session became the one on the console (fast user switch, reconnect).
    SessionActive,
}

pub const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
pub const WM_POWERBROADCAST: u32 = 0x0218;
pub const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
pub const WTS_CONSOLE_CONNECT: usize = 1;
pub const WTS_REMOTE_CONNECT: usize = 3;
pub const WTS_SESSION_LOCK: usize = 7;
pub const WTS_SESSION_UNLOCK: usize = 8;

/// Which signal a window message carries, if any.
pub fn classify(msg: u32, wparam: usize) -> Option<Signal> {
    match (msg, wparam) {
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC) => Some(Signal::Resume),
        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(Signal::Lock),
        (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => Some(Signal::Unlock),
        (WM_WTSSESSION_CHANGE, WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT) => Some(Signal::SessionActive),
        _ => None,
    }
}

static LOCKED: AtomicBool = AtomicBool::new(false);
static SHOW_ON_LOCK: AtomicBool = AtomicBool::new(false);

/// The session is locked right now.
pub fn locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// Setting `showOnLockScreen` (default off, as on the Mac).
pub fn set_show_on_lock(on: bool) {
    SHOW_ON_LOCK.store(on, Ordering::SeqCst);
    #[cfg(windows)]
    crate::fullscreen::signal();
}

/// True while the page's content should be quiet because the session is locked.
pub fn hidden_by_lock() -> bool {
    quiet_when(locked(), SHOW_ON_LOCK.load(Ordering::SeqCst))
}

pub fn quiet_when(locked: bool, show_on_lock: bool) -> bool {
    locked && !show_on_lock
}

/// What the page is told about a lock or unlock.
#[derive(Serialize, Clone)]
pub struct LockPayload {
    pub locked: bool,
}

/// What the page is told after the PC woke or the session unlocked: read Now at once.
#[derive(Serialize, Clone)]
pub struct ResumedPayload {
    pub reason: &'static str,
}

/// Applies a signal. Pure state first (`LOCKED`), then the side effects.
#[cfg(windows)]
fn handle(app: &tauri::AppHandle, s: Signal) {
    use tauri::Emitter;
    match s {
        Signal::Lock => {
            LOCKED.store(true, Ordering::SeqCst);
            crate::fullscreen::signal();
            let _ = app.emit_to("notch", "session_lock", LockPayload { locked: true });
        }
        Signal::Unlock => {
            LOCKED.store(false, Ordering::SeqCst);
            crate::fullscreen::signal();
            restore_window(app);
            crate::displays::recover(app, "unlock");
            let _ = app.emit_to("notch", "session_lock", LockPayload { locked: false });
            let _ = app.emit_to("notch", "system_resumed", ResumedPayload { reason: "unlock" });
        }
        Signal::Resume => {
            let _ = app.emit_to("notch", "system_resumed", ResumedPayload { reason: "resume" });
            if !locked() {
                restore_window(app);
                crate::displays::recover(app, "wake");
            }
        }
        Signal::SessionActive => {
            if !locked() {
                restore_window(app);
                crate::displays::recover(app, "a session switch");
            }
        }
    }
}

#[cfg(windows)]
fn restore_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("notch") {
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
        }
        crate::win::restore(&w);
    }
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    watch::start(app);
}

#[cfg(windows)]
mod watch {
    use super::*;
    use std::sync::OnceLock;
    use tauri::AppHandle;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if let Some(sig) = classify(msg, wp.0) {
            if let Some(app) = APP.get().cloned() {
                // Never block the message loop on webview or window calls.
                std::thread::spawn(move || handle(&app, sig));
            }
            // WM_POWERBROADCAST expects TRUE; WM_WTSSESSION_CHANGE ignores the result.
            return LRESULT(1);
        }
        unsafe { DefWindowProcW(h, msg, wp, lp) }
    }

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        std::thread::spawn(|| unsafe {
            let Ok(inst) = GetModuleHandleW(None) else { return };
            let class = w!("ReloSessionWatch");
            let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: inst.into(), lpszClassName: class, ..Default::default() };
            if RegisterClassW(&wc) == 0 {
                return;
            }
            // A plain top-level window (never shown): power broadcasts do not reach message-only windows.
            let Ok(hwnd) = CreateWindowExW(WS_EX_TOOLWINDOW, class, w!("Relo session watch"), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else { return };
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_err() {
                eprintln!("relo: could not register for session lock notifications");
            }
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

    #[test]
    fn classifies_the_messages_the_notch_cares_about() {
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK), Some(Signal::Lock));
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK), Some(Signal::Unlock));
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_CONSOLE_CONNECT), Some(Signal::SessionActive));
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_REMOTE_CONNECT), Some(Signal::SessionActive));
        assert_eq!(classify(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC), Some(Signal::Resume));
        // suspend (4), battery low (9), logoff (6) and other messages are ignored
        assert_eq!(classify(WM_POWERBROADCAST, 4), None);
        assert_eq!(classify(WM_WTSSESSION_CHANGE, 6), None);
        assert_eq!(classify(0x0001, WTS_SESSION_LOCK), None);
    }

    #[test]
    fn content_is_quiet_only_while_locked_and_not_shown_on_lock() {
        assert!(quiet_when(true, false));
        assert!(!quiet_when(true, true));
        assert!(!quiet_when(false, false));
    }

    #[test]
    fn payloads_are_camel_case_json() {
        assert_eq!(serde_json::to_value(LockPayload { locked: true }).unwrap(), serde_json::json!({ "locked": true }));
        assert_eq!(serde_json::to_value(ResumedPayload { reason: "resume" }).unwrap(), serde_json::json!({ "reason": "resume" }));
    }
}
