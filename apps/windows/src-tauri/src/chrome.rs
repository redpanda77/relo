//! Custom window chrome shared by Relo's own windows (Settings, Home): no native title bar, the page draws its own
//! (src/chrome/TitleBar.tsx) the way the Mac's windows hide theirs (`titlebarAppearsTransparent`, ReloGlass.prepare).
//!
//! API (small on purpose):
//! * `apply_custom_chrome(&WebviewWindow)` once from setup, after `glass::init`: Windows 11 rounded corners, the DWM
//!   shadow (and the 1px edge Windows 11 draws round a shadowed undecorated window) and the window-state events.
//!   The window itself is declared in tauri.conf.json with `"decorations": false, "transparent": true, "shadow": true`.
//! * Commands the title bar calls (all take the calling window): `chrome_ready` (page loaded: hook the WebView2 child
//!   windows), `chrome_state_get`, `chrome_minimize`, `chrome_toggle_maximize`, `chrome_close`, `chrome_snap_rect`.
//! * Events to the window: `chrome_state` {maximized, focused} and `chrome_max` {hover, pressed}.
//!
//! Why a hook on the WebView2 child windows: they cover the whole client area, so the top-level window never sees the
//! mouse. Answering `WM_NCHITTEST` there is the only way to (1) give the maximize button `HTMAXBUTTON`, which is what
//! makes Windows 11 show its Snap Layouts flyout over it, and (2) keep a resize border along the top edge, which tao
//! only offers outside the web content. While the pointer is over the maximize button Windows sends non-client
//! mouse messages, so the page gets no mouse events there: hover and press are reported back as `chrome_max`, and the
//! click is carried out here.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChromeState {
    pub maximized: bool,
    pub focused: bool,
}

fn state_of(w: &WebviewWindow) -> ChromeState {
    ChromeState { maximized: w.is_maximized().unwrap_or(false), focused: w.is_focused().unwrap_or(true) }
}

/// Call once from setup for a window declared undecorated. Safe to call for a window that is hidden.
pub fn apply_custom_chrome(w: &WebviewWindow) {
    #[cfg(windows)]
    imp::prepare(w);
    let label = w.label().to_string();
    let handle = w.app_handle().clone();
    let win = w.clone();
    w.on_window_event(move |ev| {
        if matches!(ev, WindowEvent::Resized(_) | WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. }) {
            let _ = handle.emit_to(&label, "chrome_state", state_of(&win));
        }
        // Minimizing and restoring arrive as a resize.
        if matches!(ev, WindowEvent::Resized(_)) {
            sync_page_visibility(&win);
        }
    });
    // Declared hidden in tauri.conf.json: the page must know it from the start.
    sync_page_visibility(w);
}

/// Shows the window and tells its page it is on screen again.
pub fn show(w: &WebviewWindow) -> tauri::Result<()> {
    let r = w.show();
    sync_page_visibility(w);
    r
}

/// Hides the window and tells its page, so it stops drawing.
pub fn hide(w: &WebviewWindow) {
    let _ = w.hide();
    sync_page_visibility(w);
}

/// WebView2 is not told when its window is hidden or minimized: the page keeps `document.visibilityState` "visible"
/// and runs its animations and requestAnimationFrame loops at the display's full rate for a window nobody sees (Home's
/// aurora, deck and canvases cost about a core of CPU and GPU while hidden). The controller's IsVisible is the switch
/// WebView2 documents for this: off, the page turns hidden, stops rendering and is throttled.
pub fn sync_page_visibility(w: &WebviewWindow) {
    let on_screen = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
    #[cfg(windows)]
    let _ = w.with_webview(move |wv| unsafe {
        let _ = wv.controller().SetIsVisible(on_screen);
    });
    #[cfg(not(windows))]
    let _ = on_screen;
}

#[tauri::command]
pub fn chrome_state_get(window: WebviewWindow) -> ChromeState {
    state_of(&window)
}

/// The page has loaded (its WebView2 child windows exist): hook them. Idempotent; call again after a reload.
#[tauri::command]
pub fn chrome_ready(window: WebviewWindow) {
    #[cfg(windows)]
    imp::hook(&window);
    #[cfg(not(windows))]
    let _ = window;
}

#[tauri::command]
pub fn chrome_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn chrome_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

/// Close goes through the window's own CloseRequested handler (Settings and Home hide instead of closing).
#[tauri::command]
pub fn chrome_close(window: WebviewWindow) {
    let _ = window.close();
}

/// Where the maximize button is, in physical pixels from the top-left of the window's client area
/// (`getBoundingClientRect() * devicePixelRatio`). Width or height 0 clears it (no button: no Snap Layouts hit-test).
#[tauri::command]
pub fn chrome_snap_rect(window: WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    #[cfg(windows)]
    imp::set_max_rect(&window, if width > 0 && height > 0 { Some([x, y, x + width, y + height]) } else { None });
    #[cfg(not(windows))]
    let _ = (window, x, y, width, height);
}

/// What the pointer is over, given the client size and (physical) position. Pure, so it is tested.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Zone {
    Client,
    MaxButton,
    Top,
    TopLeft,
    TopRight,
}

/// `max` is the maximize button's rectangle [left, top, right, bottom]; `border` the resize border in pixels;
/// `resizable` is false while maximized (nothing to resize).
pub fn classify(width: i32, x: i32, y: i32, max: Option<[i32; 4]>, border: i32, resizable: bool) -> Zone {
    if let Some([l, t, r, b]) = max {
        if x >= l && x < r && y >= t && y < b {
            return Zone::MaxButton;
        }
    }
    if resizable && y >= 0 && y < border && x >= 0 && x < width {
        let corner = border * 2;
        return if x < corner {
            Zone::TopLeft
        } else if x >= width - corner {
            Zone::TopRight
        } else {
            Zone::Top
        };
    }
    Zone::Client
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::HiDpi::GetSystemMetricsForDpi;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const SUBCLASS_ID: usize = 0x5265_6C6F; // "Relo"

    struct Entry {
        label: String,
        max: Option<[i32; 4]>,
        hover: bool,
        pressed: bool,
    }

    static ENTRIES: Mutex<Option<HashMap<isize, Entry>>> = Mutex::new(None);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn top_of(w: &WebviewWindow) -> Option<HWND> {
        // Rebuilt from the raw pointer: tauri's `windows` version may differ from ours.
        w.hwnd().ok().map(|h| HWND(h.0 as _))
    }

    pub fn prepare(w: &WebviewWindow) {
        let _ = APP.set(w.app_handle().clone());
        let Some(hwnd) = top_of(w) else { return };
        // Windows 11: round the corners (a no-op, harmless error, on Windows 10).
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const _, std::mem::size_of_val(&pref) as u32);
        }
        // The DWM shadow (and with it the 1px edge) of an undecorated window.
        let _ = w.set_shadow(true);
        let mut g = ENTRIES.lock().unwrap();
        g.get_or_insert_with(HashMap::new).entry(hwnd.0 as isize).or_insert(Entry { label: w.label().to_string(), max: None, hover: false, pressed: false });
    }

    pub fn set_max_rect(w: &WebviewWindow, rect: Option<[i32; 4]>) {
        let Some(hwnd) = top_of(w) else { return };
        let mut g = ENTRIES.lock().unwrap();
        if let Some(e) = g.get_or_insert_with(HashMap::new).get_mut(&(hwnd.0 as isize)) {
            e.max = rect;
        }
    }

    pub fn hook(w: &WebviewWindow) {
        let Some(top) = top_of(w) else { return };
        unsafe extern "system" fn each(child: HWND, lparam: LPARAM) -> BOOL {
            let _ = SetWindowSubclass(child, Some(child_proc), SUBCLASS_ID, lparam.0 as usize);
            BOOL(1)
        }
        unsafe {
            let _ = EnumChildWindows(Some(top), Some(each), LPARAM(top.0 as isize));
        }
    }

    fn lo(l: LPARAM) -> i32 {
        (l.0 & 0xFFFF) as i16 as i32
    }
    fn hi(l: LPARAM) -> i32 {
        ((l.0 >> 16) & 0xFFFF) as i16 as i32
    }

    fn report(top: HWND) {
        let (label, hover, pressed) = {
            let g = ENTRIES.lock().unwrap();
            match g.as_ref().and_then(|m| m.get(&(top.0 as isize))) {
                Some(e) => (e.label.clone(), e.hover, e.pressed),
                None => return,
            }
        };
        #[derive(Serialize, Clone)]
        struct MaxState {
            hover: bool,
            pressed: bool,
        }
        if let Some(app) = APP.get() {
            let _ = app.emit_to(&label, "chrome_max", MaxState { hover, pressed });
        }
    }

    fn set_flags(top: HWND, hover: Option<bool>, pressed: Option<bool>) {
        {
            let mut g = ENTRIES.lock().unwrap();
            if let Some(e) = g.as_mut().and_then(|m| m.get_mut(&(top.0 as isize))) {
                if let Some(h) = hover {
                    e.hover = h;
                }
                if let Some(p) = pressed {
                    e.pressed = p;
                }
            }
        }
        report(top);
    }

    unsafe extern "system" fn child_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, top: usize) -> LRESULT {
        let top_hwnd = HWND(top as _);
        match msg {
            WM_NCHITTEST => {
                let mut pt = POINT { x: lo(lparam), y: hi(lparam) };
                let mut rc = RECT::default();
                if ScreenToClient(top_hwnd, &mut pt).as_bool() && GetClientRect(top_hwnd, &mut rc).is_ok() {
                    let max = ENTRIES.lock().unwrap().as_ref().and_then(|m| m.get(&(top as isize))).and_then(|e| e.max);
                    let border = GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(top_hwnd));
                    let resizable = !IsZoomed(top_hwnd).as_bool();
                    return match classify(rc.right - rc.left, pt.x, pt.y, max, border, resizable) {
                        Zone::MaxButton => LRESULT(HTMAXBUTTON as isize),
                        Zone::Top => LRESULT(HTTOP as isize),
                        Zone::TopLeft => LRESULT(HTTOPLEFT as isize),
                        Zone::TopRight => LRESULT(HTTOPRIGHT as isize),
                        Zone::Client => DefSubclassProc(hwnd, msg, wparam, lparam),
                    };
                }
            }
            WM_NCMOUSEMOVE if wparam.0 as u32 == HTMAXBUTTON => {
                let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                let _ = TrackMouseEvent(&mut t);
                set_flags(top_hwnd, Some(true), None);
                return LRESULT(0);
            }
            WM_NCMOUSELEAVE => {
                set_flags(top_hwnd, Some(false), Some(false));
                return LRESULT(0);
            }
            WM_NCLBUTTONDOWN if wparam.0 as u32 == HTMAXBUTTON => {
                set_flags(top_hwnd, None, Some(true));
                return LRESULT(0);
            }
            WM_NCLBUTTONUP if wparam.0 as u32 == HTMAXBUTTON => {
                set_flags(top_hwnd, None, Some(false));
                let _ = ShowWindow(top_hwnd, if IsZoomed(top_hwnd).as_bool() { SW_RESTORE } else { SW_MAXIMIZE });
                return LRESULT(0);
            }
            // The top border is the window's: let it run its own resize loop.
            WM_NCLBUTTONDOWN if matches!(wparam.0 as u32, HTTOP | HTTOPLEFT | HTTOPRIGHT) => {
                return SendMessageW(top_hwnd, msg, Some(wparam), Some(lparam));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones() {
        let max = Some([700, 0, 746, 32]);
        assert_eq!(classify(800, 710, 10, max, 4, true), Zone::MaxButton);
        // the button wins over the resize border it touches
        assert_eq!(classify(800, 710, 1, max, 4, true), Zone::MaxButton);
        assert_eq!(classify(800, 400, 2, max, 4, true), Zone::Top);
        assert_eq!(classify(800, 3, 2, max, 4, true), Zone::TopLeft);
        assert_eq!(classify(800, 795, 2, max, 4, true), Zone::TopRight);
        assert_eq!(classify(800, 400, 10, max, 4, true), Zone::Client);
        // maximized: no border; still a button
        assert_eq!(classify(800, 400, 2, max, 4, false), Zone::Client);
        assert_eq!(classify(800, 720, 5, max, 4, false), Zone::MaxButton);
        // no rect set: no button
        assert_eq!(classify(800, 720, 5, None, 4, true), Zone::Client);
        // outside the client area
        assert_eq!(classify(800, -2, 2, None, 4, true), Zone::Client);
    }
}
