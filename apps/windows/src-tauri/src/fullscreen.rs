//! Fullscreen quiet: tell the page to hide its content (never the HWND: a hidden WebView2 stops painting)
//! while a fullscreen app is in front. Event-driven: the foreground hook in win.rs and a foreground-window
//! LOCATIONCHANGE hook call `signal()`; a worker evaluates, then once more 1.5 s later (exclusive D3D
//! reports through SHQueryUserNotificationState a moment after the switch).

use serde::Serialize;

/// Plain rect so the decision stays pure and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct R {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreground {
    pub rect: R,
    pub monitor: R,
    pub class: String,
    pub has_caption: bool,
    pub visible: bool,
    pub minimized: bool,
}

/// SHQueryUserNotificationState values that mean "a fullscreen/presenting app owns the screen".
pub const QUNS_BUSY: i32 = 2;
pub const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
pub const QUNS_PRESENTATION_MODE: i32 = 4;

const SHELL_CLASSES: [&str; 4] = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

pub fn quns_is_fullscreen(state: i32) -> bool {
    matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
}

pub fn covers_monitor(f: &Foreground) -> bool {
    let (r, m) = (f.rect, f.monitor);
    f.visible
        && !f.minimized
        && !f.has_caption // a maximized captioned window is not fullscreen
        && !SHELL_CLASSES.contains(&f.class.as_str()) // the desktop and taskbar can span the monitor
        && r.l <= m.l
        && r.t <= m.t
        && r.r >= m.r
        && r.b >= m.b
}

/// Fullscreen if the shell says so, or the foreground window is a caption-less window covering its monitor.
/// `is_own` (our notch in front) never counts.
pub fn decide(quns: i32, fg: Option<&Foreground>, is_own: bool) -> bool {
    if is_own {
        return false;
    }
    quns_is_fullscreen(quns) || fg.is_some_and(covers_monitor)
}

#[derive(Serialize, Clone)]
pub struct FullscreenPayload {
    pub fullscreen: bool,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{HMODULE, HWND, RECT};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::*;

    static TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
    static CURRENT: AtomicBool = AtomicBool::new(false);

    /// Ask the worker to re-evaluate. Cheap and non-blocking; safe from a hook callback.
    pub fn signal() {
        if let Some(tx) = TX.get() {
            let _ = tx.send(());
        }
    }

    pub fn current() -> bool {
        CURRENT.load(Ordering::Relaxed)
    }

    fn r(rc: RECT) -> R {
        R { l: rc.left, t: rc.top, r: rc.right, b: rc.bottom }
    }

    fn query(own: HWND) -> bool {
        unsafe {
            let quns = SHQueryUserNotificationState().map(|s| s.0).unwrap_or(0);
            let hwnd = GetForegroundWindow();
            let mut fg = None;
            if !hwnd.0.is_null() {
                let mut rc = RECT::default();
                let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                let mut buf = [0u16; 128];
                let n = GetClassNameW(hwnd, &mut buf) as usize;
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
                if GetWindowRect(hwnd, &mut rc).is_ok()
                    && GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool()
                {
                    fg = Some(Foreground {
                        rect: r(rc),
                        monitor: r(mi.rcMonitor),
                        class: String::from_utf16_lossy(&buf[..n]),
                        has_caption: style & WS_CAPTION.0 == WS_CAPTION.0,
                        visible: IsWindowVisible(hwnd).as_bool(),
                        minimized: IsIconic(hwnd).as_bool(),
                    });
                }
            }
            decide(quns, fg.as_ref(), hwnd == own)
        }
    }

    fn evaluate(app: &AppHandle) {
        let own = app
            .get_webview_window("notch")
            .and_then(|w| w.hwnd().ok())
            .map(|h| HWND(h.0 as _))
            .unwrap_or_default();
        // A locked session counts as quiet (unless "show on lock screen"): session.rs.
        let now = query(own) || crate::session::hidden_by_lock();
        if CURRENT.swap(now, Ordering::Relaxed) != now {
            let _ = app.emit_to("notch", "notch_fullscreen", FullscreenPayload { fullscreen: now });
            crate::mirrors::emit_all(app, "notch_fullscreen", FullscreenPayload { fullscreen: now }); // MIRRORS
        }
    }

    unsafe extern "system" fn on_move(_h: HWINEVENTHOOK, _e: u32, hwnd: HWND, object: i32, _c: i32, _t: u32, _ms: u32) {
        // Only the foreground window's own frame (F11 in a browser, a game switching to borderless).
        if object == OBJID_WINDOW.0 && hwnd == unsafe { GetForegroundWindow() } {
            signal();
        }
    }

    pub fn start(app: AppHandle) {
        let (tx, rx) = mpsc::channel::<()>();
        let _ = TX.set(tx);
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                evaluate(&app);
                std::thread::sleep(Duration::from_millis(1500));
                while rx.try_recv().is_ok() {}
                evaluate(&app);
            }
        });
        std::thread::spawn(|| unsafe {
            let hook = SetWinEventHook(
                EVENT_OBJECT_LOCATIONCHANGE,
                EVENT_OBJECT_LOCATIONCHANGE,
                None::<HMODULE>,
                Some(on_move),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_invalid() {
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                DispatchMessageW(&msg);
            }
            let _ = UnhookWinEvent(hook);
        });
        signal();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: R = R { l: 0, t: 0, r: 1920, b: 1080 };
    fn fg(rect: R, class: &str, caption: bool) -> Foreground {
        Foreground { rect, monitor: MON, class: class.into(), has_caption: caption, visible: true, minimized: false }
    }

    #[test]
    fn shell_states() {
        assert!(!quns_is_fullscreen(1)); // NOT_PRESENT
        assert!(quns_is_fullscreen(QUNS_BUSY));
        assert!(quns_is_fullscreen(QUNS_RUNNING_D3D_FULL_SCREEN));
        assert!(quns_is_fullscreen(QUNS_PRESENTATION_MODE));
        assert!(!quns_is_fullscreen(5)); // ACCEPTS_NOTIFICATIONS
        assert!(!quns_is_fullscreen(6)); // QUIET_TIME
    }

    #[test]
    fn borderless_window_covering_the_monitor_is_fullscreen() {
        assert!(decide(5, Some(&fg(MON, "UnrealWindow", false)), false));
    }

    #[test]
    fn maximized_captioned_window_is_not() {
        let max = R { l: -8, t: -8, r: 1928, b: 1088 };
        assert!(!decide(5, Some(&fg(max, "Chrome_WidgetWin_1", true)), false));
    }

    #[test]
    fn desktop_and_taskbar_are_excluded() {
        for c in ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"] {
            assert!(!decide(5, Some(&fg(MON, c, false)), false), "{c}");
        }
    }

    #[test]
    fn partial_hidden_or_minimized_windows_are_not() {
        assert!(!decide(5, Some(&fg(R { l: 0, t: 0, r: 1920, b: 1040 }, "App", false)), false));
        let mut f = fg(MON, "App", false);
        f.minimized = true;
        assert!(!decide(5, Some(&f), false));
        f.minimized = false;
        f.visible = false;
        assert!(!decide(5, Some(&f), false));
    }

    #[test]
    fn shell_state_alone_and_own_window() {
        assert!(decide(QUNS_RUNNING_D3D_FULL_SCREEN, None, false));
        assert!(!decide(QUNS_BUSY, Some(&fg(MON, "App", false)), true));
    }
}
