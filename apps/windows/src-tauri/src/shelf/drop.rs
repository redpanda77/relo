//! Drag IN: an OLE drop target on the notch window, and the poller that lets a drag reach it.
//! See the module docs in mod.rs for why this is native and not Tauri's drag-drop events.

use super::native::{com_init, wide};
use super::{emit_drag, ingest, zone_for, Dropped, CAPTURE, DRAGGING_OUT, DRAG_OVER};
use crate::shelf::zones;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use windows::core::{implement, PCWSTR};
use windows::Win32::Foundation::{DRAGDROP_E_INVALIDHWND, HWND, POINT, POINTL, RECT};
use windows::Win32::System::Com::*;
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::*;
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetCursorPos, GetWindowRect};
use windows::core::BOOL;

static NOTCH_HWND: AtomicIsize = AtomicIsize::new(0);
const MAX_VIRTUAL_FILE: usize = 256 * 1024 * 1024;

fn reg(name: &str) -> u16 {
    let w = wide(name);
    unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) as u16 }
}

struct Formats {
    url_w: u16,
    group_w: u16,
    contents: u16,
    png: u16,
}
fn formats() -> &'static Formats {
    static F: std::sync::OnceLock<Formats> = std::sync::OnceLock::new();
    F.get_or_init(|| Formats { url_w: reg("UniformResourceLocatorW"), group_w: reg("FileGroupDescriptorW"), contents: reg("FileContents"), png: reg("PNG") })
}

fn fmt(cf: u16, tymed: TYMED, index: i32) -> FORMATETC {
    FORMATETC { cfFormat: cf, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: index, tymed: tymed.0 as u32 }
}

fn has(data: &IDataObject, cf: u16) -> bool {
    unsafe { data.QueryGetData(&fmt(cf, TYMED_HGLOBAL, -1)).is_ok() }
}

/// Whether the shelf can take anything from this drag.
fn acceptable(data: &IDataObject) -> bool {
    let f = formats();
    has(data, CF_HDROP.0 as u16) || has(data, f.group_w) || has(data, f.url_w) || has(data, CF_UNICODETEXT.0 as u16) || has(data, f.png)
}

unsafe fn hglobal_bytes(medium: &STGMEDIUM) -> Option<Vec<u8>> {
    let h = medium.u.hGlobal;
    let size = GlobalSize(h);
    let p = GlobalLock(h) as *const u8;
    if p.is_null() {
        return None;
    }
    let v = std::slice::from_raw_parts(p, size).to_vec();
    let _ = GlobalUnlock(h);
    Some(v)
}

fn utf16_until_nul(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|u| *u != 0).collect();
    String::from_utf16_lossy(&units)
}

fn get_hglobal(data: &IDataObject, cf: u16) -> Option<Vec<u8>> {
    unsafe {
        let mut m = data.GetData(&fmt(cf, TYMED_HGLOBAL, -1)).ok()?;
        let v = hglobal_bytes(&m);
        ReleaseStgMedium(&mut m);
        v
    }
}

fn read_stream(stream: &IStream) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        let hr = unsafe { stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read)) };
        if hr.is_err() || read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read as usize]);
        if out.len() > MAX_VIRTUAL_FILE {
            return None;
        }
    }
    Some(out)
}

/// Files an app offers without a file on disk (a browser's image, a mail attachment): CFSTR_FILEDESCRIPTORW +
/// CFSTR_FILECONTENTS. Each becomes a temporary file on the shelf.
fn virtual_files(data: &IDataObject) -> Vec<Dropped> {
    const DESC: usize = 592; // sizeof(FILEDESCRIPTORW)
    const NAME_AT: usize = 72;
    const DIR: u32 = 0x10;
    let f = formats();
    let Some(group) = get_hglobal(data, f.group_w) else { return Vec::new() };
    if group.len() < 4 {
        return Vec::new();
    }
    let n = u32::from_le_bytes(group[..4].try_into().unwrap()) as usize;
    let mut out = Vec::new();
    for i in 0..n.min(64) {
        let base = 4 + i * DESC;
        if group.len() < base + DESC {
            break;
        }
        let attrs = u32::from_le_bytes(group[base + 56..base + 60].try_into().unwrap());
        if attrs & DIR != 0 {
            continue;
        }
        let name = utf16_until_nul(&group[base + NAME_AT..base + DESC]);
        let bytes = unsafe {
            let want = TYMED(TYMED_ISTREAM.0 | TYMED_HGLOBAL.0);
            match data.GetData(&fmt(f.contents, want, i as i32)) {
                Ok(mut m) => {
                    let v = if m.tymed == TYMED_ISTREAM.0 as u32 {
                        m.u.pstm.as_ref().and_then(read_stream)
                    } else if m.tymed == TYMED_HGLOBAL.0 as u32 {
                        hglobal_bytes(&m)
                    } else {
                        None
                    };
                    ReleaseStgMedium(&mut m);
                    v
                }
                Err(_) => None,
            }
        };
        if let Some(data) = bytes {
            out.push(Dropped::Bytes { name, data });
        }
    }
    out
}

/// What a drop carries, best representation first (the Mac's order: file, URL, text, data).
fn extract(data: &IDataObject) -> Vec<Dropped> {
    let f = formats();
    unsafe {
        if has(data, CF_HDROP.0 as u16) {
            if let Ok(mut m) = data.GetData(&fmt(CF_HDROP.0 as u16, TYMED_HGLOBAL, -1)) {
                let h = HDROP(m.u.hGlobal.0);
                let count = DragQueryFileW(h, 0xFFFF_FFFF, None);
                let mut out = Vec::new();
                for i in 0..count {
                    let len = DragQueryFileW(h, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    let got = DragQueryFileW(h, i, Some(&mut buf)) as usize;
                    out.push(Dropped::Path(String::from_utf16_lossy(&buf[..got])));
                }
                ReleaseStgMedium(&mut m);
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }
    if has(data, f.group_w) {
        let v = virtual_files(data);
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(b) = get_hglobal(data, f.url_w) {
        let u = utf16_until_nul(&b);
        if !u.is_empty() {
            return vec![Dropped::Link(u)];
        }
    }
    if let Some(b) = get_hglobal(data, CF_UNICODETEXT.0 as u16) {
        let t = utf16_until_nul(&b);
        if !t.trim().is_empty() {
            return vec![Dropped::Text(t)];
        }
    }
    if let Some(b) = get_hglobal(data, f.png) {
        return vec![Dropped::Bytes { name: "image.png".into(), data: b }];
    }
    Vec::new()
}

// ---- The drop target ----

fn window_point(x: i32, y: i32) -> (f64, f64) {
    let hwnd = HWND(NOTCH_HWND.load(Ordering::Relaxed) as _);
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut r);
    }
    ((x - r.left) as f64, (y - r.top) as f64)
}

#[implement(IDropTarget)]
struct Target;

impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(&self, pdataobj: windows::core::Ref<'_, IDataObject>, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, pdweffect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let ok = !DRAGGING_OUT.load(Ordering::SeqCst) && pdataobj.as_ref().map(acceptable).unwrap_or(false) && super::settings_now().enabled;
        unsafe {
            *pdweffect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
        if ok {
            DRAG_OVER.store(true, Ordering::SeqCst);
            let (x, y) = window_point(pt.x, pt.y);
            emit_drag("enter", x, y, zone_for(x, y), 0);
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, pdweffect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let on = DRAG_OVER.load(Ordering::SeqCst);
        unsafe {
            *pdweffect = if on { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
        if on {
            let (x, y) = window_point(pt.x, pt.y);
            emit_drag("over", x, y, zone_for(x, y), 0);
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if DRAG_OVER.swap(false, Ordering::SeqCst) {
            emit_drag("leave", 0.0, 0.0, zones::Zone::Shelf, 0);
        }
        Ok(())
    }

    fn Drop(&self, pdataobj: windows::core::Ref<'_, IDataObject>, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, pdweffect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let was_over = DRAG_OVER.swap(false, Ordering::SeqCst);
        unsafe {
            *pdweffect = if was_over { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
        if !was_over {
            return Ok(());
        }
        let (x, y) = window_point(pt.x, pt.y);
        let zone = zone_for(x, y);
        let dropped = pdataobj.as_ref().map(extract).unwrap_or_default();
        let added = match zone {
            zones::Zone::Shelf => ingest(dropped),
            zones::Zone::Share => {
                // Files go to the share sheet; anything else is shared as a stand-in file after being kept.
                let paths: Vec<std::path::PathBuf> = dropped
                    .iter()
                    .filter_map(|d| match d {
                        Dropped::Path(p) => Some(std::path::PathBuf::from(p)),
                        _ => None,
                    })
                    .collect();
                let app = super::shared().map(|s| s.app.clone());
                if let (Ok(app), false) = (app, paths.is_empty()) {
                    let _ = std::thread::spawn(move || {
                        if let Err(e) = super::share_paths(&app, paths) {
                            eprintln!("relo: share failed: {e}");
                        }
                    });
                }
                0
            }
        };
        emit_drag("drop", x, y, zone, added);
        Ok(())
    }
}

unsafe extern "system" fn register_child(h: HWND, l: windows::Win32::Foundation::LPARAM) -> BOOL {
    // OLE does not climb from WebView2's inner windows to their parent: the target has to be on every one of them
    // (wry's own drag-drop does the same). A window that is not ours to register on (INVALIDHWND) is skipped.
    let target = &*(l.0 as *const IDropTarget);
    if RevokeDragDrop(h) != Err(DRAGDROP_E_INVALIDHWND.into()) {
        let _ = RegisterDragDrop(h, target);
    }
    BOOL(1)
}

/// Put the drop target on the notch window and every window WebView2 has under it. Main thread only; run again
/// when WebView2 creates windows late.
fn register_everywhere() {
    let hwnd = HWND(NOTCH_HWND.load(Ordering::SeqCst) as _);
    let target: IDropTarget = Target.into();
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        let _ = RegisterDragDrop(hwnd, &target);
        let _ = EnumChildWindows(Some(hwnd), Some(register_child), windows::Win32::Foundation::LPARAM(&target as *const IDropTarget as isize));
    }
}

/// Take the notch window as a drop target. Runs on the main thread (OLE needs the window's own thread).
pub fn install(app: &AppHandle) {
    let Some(w) = app.get_webview_window("notch") else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    NOTCH_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller4;
        use windows_core_062::Interface;
        let _ = OleInitialize(None);
        // WebView2 would take the drop itself (navigating to the file): turn that off so the OS finds our target.
        match wv.controller().cast::<ICoreWebView2Controller4>() {
            Ok(c4) => {
                let _ = c4.SetAllowExternalDrop(false);
            }
            Err(e) => eprintln!("relo: shelf: cannot disable WebView2's own drop handling: {e}"),
        }
        register_everywhere();
    });
    // WebView2 may register its own target late: sweep again once it has settled.
    let a = app.clone();
    std::thread::spawn(move || {
        for ms in [1500u64, 4000] {
            std::thread::sleep(Duration::from_millis(ms));
            let _ = a.run_on_main_thread(register_everywhere);
        }
    });
    start_poller(app.clone());
}

/// DragDetector for Windows: while the left button is down and has moved, over the drag region, ask the window to
/// stop being click-through so OLE can see it. A plain click never gets that far (movement threshold), and nothing
/// opens until OLE reports a real drag with usable data.
fn start_poller(app: AppHandle) {
    std::thread::spawn(move || {
        com_init();
        let mut down_at: Option<(i32, i32)> = None;
        loop {
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            let mut cur = POINT::default();
            let have_cursor = unsafe { GetCursorPos(&mut cur).is_ok() };
            let settings = super::settings_now();
            if !down || !have_cursor || !settings.enabled {
                down_at = None;
                CAPTURE.store(false, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(if settings.enabled { 40 } else { 250 }));
                continue;
            }
            let origin = *down_at.get_or_insert((cur.x, cur.y));
            let hwnd = HWND(NOTCH_HWND.load(Ordering::Relaxed) as _);
            let mut r = RECT::default();
            let (dpi, got) = unsafe { (GetDpiForWindow(hwnd), GetWindowRect(hwnd, &mut r).is_ok()) };
            let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
            let inside = got
                && super::drag_region(scale).map(|reg| zones::contains(reg, (cur.x - r.left) as f64, (cur.y - r.top) as f64)).unwrap_or(false);
            let moving = zones::moved_enough(origin, (cur.x, cur.y), 4);
            let want = inside && moving && !DRAGGING_OUT.load(Ordering::SeqCst);
            if want != CAPTURE.swap(want, Ordering::SeqCst) && want {
                // Do not wait for the pointer loop's next tick: the drag may be about to drop.
                if let Some(w) = app.get_webview_window("notch") {
                    let _ = w.set_ignore_cursor_events(false);
                }
                let _ = app.run_on_main_thread(register_everywhere);
            }
            std::thread::sleep(Duration::from_millis(12));
        }
    });
}
