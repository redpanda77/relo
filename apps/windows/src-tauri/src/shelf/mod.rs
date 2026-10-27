//! The Shelf for Windows: the port of boringNotch's Shelf (components/Shelf/**, DragDetector.swift).
//!
//! Drag IN is a native OLE `IDropTarget` on the notch window (`drop.rs`), not Tauri's drag-drop events: those carry
//! file paths only, while the Mac shelf also keeps text, links and data without a file. Drag OUT is a native
//! `DoDragDrop` with a shell data object (`native.rs`), so Explorer and other apps get real files.
//!
//! The notch window is click-through outside its hot rect, and a click-through window is invisible to OLE. So
//! `drop::start_poller` plays DragDetector's part: while the left button is down and moving over the drag region
//! (the open notch's area when "expanded drag detection" is on) the window stops being click-through; the OLE
//! `DragEnter` that follows is the proof that a real drag with usable data is in flight (the Mac compares the drag
//! pasteboard's change count for the same purpose). `DRAG_OVER` then holds the notch open through `main.rs`'s
//! pointer loop, exactly as hovering does.

pub mod model;
pub mod store;
pub mod zones;

#[cfg(windows)]
mod drop;
#[cfg(windows)]
mod native;

use model::{as_link, Item, ItemView, Kind, Settings};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use store::Store;
use tauri::{AppHandle, Emitter, Manager};
use zones::{Rect, Zone};

/// An OLE drag with usable data is over the notch window.
pub static DRAG_OVER: AtomicBool = AtomicBool::new(false);
/// A button-down drag is inside the drag region: the window must accept mouse input (not be click-through).
pub static CAPTURE: AtomicBool = AtomicBool::new(false);
/// A shelf dialog, menu or share sheet is up: keep the notch open under it.
static BUSY: AtomicBool = AtomicBool::new(false);
/// This process started a drag out of the shelf: never take it back in.
pub static DRAGGING_OUT: AtomicBool = AtomicBool::new(false);

static SHARE_RECT: Mutex<Option<Rect>> = Mutex::new(None);
static HOT: Mutex<Option<Rect>> = Mutex::new(None);

struct Shared {
    app: AppHandle,
    store: Mutex<Store>,
}
static SHARED: OnceLock<Shared> = OnceLock::new();

fn shared() -> Result<&'static Shared, String> {
    SHARED.get().ok_or_else(|| "the shelf is not running".to_string())
}

// ---- Hooks for main.rs ----

/// True while the pointer loop should treat the cursor as over the notch (opens it, keeps it open).
pub fn keep_open() -> bool {
    DRAG_OVER.load(Ordering::Relaxed) || BUSY.load(Ordering::Relaxed)
}
/// True while the window must take mouse input for an incoming drag.
pub fn capturing() -> bool {
    CAPTURE.load(Ordering::Relaxed) || DRAG_OVER.load(Ordering::Relaxed)
}
/// The page's hot rect (same value main.rs keeps), for sizing the drag region.
pub fn note_hot(rect: Rect) {
    *HOT.lock().unwrap() = Some(rect);
}

pub fn init(app: &AppHandle) {
    let Some(root) = store::default_root() else {
        eprintln!("relo: shelf disabled, LOCALAPPDATA is not set");
        return;
    };
    let store = Store::open(root);
    store.sweep();
    let _ = SHARED.set(Shared { app: app.clone(), store: Mutex::new(store) });
    emit_items();
    #[cfg(windows)]
    {
        drop::install(app);
        native::install_menu_events(app);
    }
}

fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let s = shared()?;
    let mut g = s.store.lock().map_err(|_| "shelf state is poisoned".to_string())?;
    Ok(f(&mut g))
}

fn views() -> Vec<ItemView> {
    with_store(|s| s.items.iter().map(Item::view).collect()).unwrap_or_default()
}

fn emit_items() {
    if let Ok(s) = shared() {
        let _ = s.app.emit("shelf_items", views());
    }
}

fn settings_now() -> Settings {
    with_store(|s| s.settings.clone()).unwrap_or_default()
}

// ---- What a drop carries ----

#[derive(Debug, Clone)]
pub enum Dropped {
    Path(String),
    Text(String),
    Link(String),
    /// Data with no file behind it (a browser's image, an e-mail attachment): kept as a temporary file.
    Bytes { name: String, data: Vec<u8> },
}

/// Turn a drop into shelf items and add them. Returns how many were new.
pub fn ingest(dropped: Vec<Dropped>) -> usize {
    let n = with_store(|s| {
        let mut items = Vec::new();
        for d in dropped {
            match d {
                Dropped::Path(p) => {
                    if std::path::Path::new(&p).exists() {
                        items.push(Item::new(Kind::File { path: p }, false));
                    }
                }
                Dropped::Link(u) => items.push(Item::new(Kind::Link { url: u }, false)),
                Dropped::Text(t) => {
                    if t.trim().is_empty() {
                        continue;
                    }
                    match as_link(&t) {
                        Some(u) => items.push(Item::new(Kind::Link { url: u }, false)),
                        None => items.push(Item::new(Kind::Text { text: t }, false)),
                    }
                }
                Dropped::Bytes { name, data } => {
                    if let Ok(p) = s.create_temp_file(&data, Some(&name)) {
                        items.push(Item::new(Kind::File { path: p.to_string_lossy().into_owned() }, true));
                    }
                }
            }
        }
        s.add(items).len()
    })
    .unwrap_or(0);
    if n > 0 {
        emit_items();
    }
    n
}

// ---- Drag events for the page ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DragEvent {
    /// "enter" | "over" | "leave" | "drop"
    pub phase: &'static str,
    /// Window-relative physical px (the page divides by devicePixelRatio).
    pub x: f64,
    pub y: f64,
    pub zone: Zone,
    pub added: usize,
}

pub fn emit_drag(phase: &'static str, x: f64, y: f64, zone: Zone, added: usize) {
    if let Ok(s) = shared() {
        let _ = s.app.emit_to("notch", "shelf_drag", DragEvent { phase, x, y, zone, added });
    }
}

pub fn zone_for(x: f64, y: f64) -> Zone {
    zones::zone_at(*SHARE_RECT.lock().unwrap(), x, y)
}

#[cfg(windows)]
pub fn drag_region(scale: f64) -> Option<Rect> {
    let s = settings_now();
    if !s.enabled {
        return None;
    }
    let hot = *HOT.lock().unwrap();
    zones::drag_region(hot, s.expanded_drag_detection, scale)
}

// ---- Commands ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    items: Vec<ItemView>,
    settings: Settings,
}

#[tauri::command]
pub fn shelf_snapshot() -> Snapshot {
    Snapshot { items: views(), settings: settings_now() }
}

#[tauri::command]
pub fn shelf_settings_set(app: AppHandle, patch: Value) -> Result<Settings, String> {
    let s = with_store(|s| {
        let next = s.settings.patched(&patch);
        s.set_settings(next.clone()).map(|_| next)
    })??;
    let _ = app.emit("shelf_settings", &s);
    Ok(s)
}

/// Files the page or a test hands over (paths only; text and links arrive through drops).
#[tauri::command]
pub fn shelf_add_paths(paths: Vec<String>) -> usize {
    ingest(paths.into_iter().map(Dropped::Path).collect())
}

#[tauri::command]
pub fn shelf_add_text(text: String) -> usize {
    ingest(vec![Dropped::Text(text)])
}

#[tauri::command]
pub fn shelf_remove(ids: Vec<String>) -> usize {
    let n = with_store(|s| s.remove_many(&ids)).unwrap_or(0);
    if n > 0 {
        emit_items();
    }
    n
}

/// The Mac's `cleanupInvalidItems`, run when the shelf appears.
#[tauri::command]
pub fn shelf_cleanup() -> usize {
    let n = with_store(|s| s.retain_valid()).unwrap_or(0);
    if n > 0 {
        emit_items();
    }
    n
}

#[tauri::command]
pub fn shelf_rename(id: String, name: String) -> Result<(), String> {
    with_store(|s| s.rename(&id, &name))??;
    emit_items();
    Ok(())
}

/// The page's share tile, in window-relative physical px; null while the shelf is not on screen.
#[tauri::command]
pub fn shelf_set_share_rect(rect: Option<Rect>) {
    *SHARE_RECT.lock().unwrap() = rect;
}

fn item_of(id: &str) -> Result<Item, String> {
    with_store(|s| s.get(id).cloned())?.ok_or_else(|| "that item is no longer on the shelf".to_string())
}

/// Paths for items; text and links become small stand-in files.
pub(crate) fn paths_of(ids: &[String]) -> Result<Vec<PathBuf>, String> {
    with_store(|s| {
        let mut out = Vec::new();
        for id in ids {
            let Some(it) = s.get(id).cloned() else { continue };
            match &it.kind {
                Kind::File { path } => {
                    if std::path::Path::new(path).exists() {
                        out.push(PathBuf::from(path));
                    }
                }
                _ => out.push(s.stand_in(&it)?),
            }
        }
        Ok::<_, String>(out)
    })?
}

fn only_files(ids: &[String]) -> Vec<PathBuf> {
    with_store(|s| {
        ids.iter()
            .filter_map(|id| match s.get(id).map(|i| i.kind.clone()) {
                Some(Kind::File { path }) => Some(PathBuf::from(path)),
                _ => None,
            })
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(windows)]
mod commands {
    use super::*;
    use tauri::ipc::Response;
    use tauri::WebviewWindow;

    fn notch(app: &AppHandle) -> Result<WebviewWindow, String> {
        app.get_webview_window("notch").ok_or_else(|| "no notch window".to_string())
    }

    struct Busy;
    impl Busy {
        fn on() -> Busy {
            BUSY.store(true, Ordering::SeqCst);
            Busy
        }
    }
    impl Drop for Busy {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::SeqCst);
        }
    }

    /// Double click / Return: files open in their app, links in the browser, text goes to the clipboard.
    #[tauri::command]
    pub fn shelf_open(id: String) -> Result<(), String> {
        let it = item_of(&id)?;
        match &it.kind {
            Kind::File { path } => native::open_path(path),
            Kind::Link { url } => native::open_link(url),
            Kind::Text { text } => native::clipboard_text(text),
        }
    }

    #[tauri::command]
    pub fn shelf_reveal(ids: Vec<String>) -> Result<(), String> {
        for p in only_files(&ids) {
            native::reveal(&p)?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn shelf_open_with(id: String) -> Result<(), String> {
        match item_of(&id)?.kind {
            Kind::File { path } => native::open_with(&path),
            _ => Err("only files can be opened with another app".into()),
        }
    }

    /// Quick Look: Windows has no built-in equivalent, so the item opens in its default app (PowerToys Peek is
    /// bound to Explorer's selection and cannot be pointed at a path).
    #[tauri::command]
    pub fn shelf_quick_look(ids: Vec<String>) -> Result<(), String> {
        for id in ids.iter().take(1) {
            shelf_open(id.clone())?;
        }
        Ok(())
    }

    #[tauri::command]
    pub fn shelf_copy_path(ids: Vec<String>) -> Result<(), String> {
        let paths: Vec<String> = only_files(&ids).iter().map(|p| p.to_string_lossy().into_owned()).collect();
        if paths.is_empty() {
            return Ok(());
        }
        native::clipboard_text(&paths.join("\r\n"))
    }

    /// Copy: the files go on the clipboard as files (paste in Explorer); text and links as text.
    #[tauri::command]
    pub fn shelf_copy(ids: Vec<String>) -> Result<(), String> {
        let files = only_files(&ids);
        if !files.is_empty() {
            return native::clipboard_files(&files);
        }
        let texts: Vec<String> = with_store(|s| {
            ids.iter()
                .filter_map(|id| match s.get(id).map(|i| i.kind.clone()) {
                    Some(Kind::Text { text }) => Some(text),
                    Some(Kind::Link { url }) => Some(url),
                    _ => None,
                })
                .collect()
        })?;
        native::clipboard_text(&texts.join("\r\n"))
    }

    #[tauri::command]
    pub async fn shelf_thumbnail(id: String, size: u32) -> Result<Response, String> {
        let it = item_of(&id)?;
        let Kind::File { path } = it.kind else { return Err("no thumbnail".into()) };
        let size = size.clamp(16, 256) as i32;
        let png = tauri::async_runtime::spawn_blocking(move || native::thumbnail_png(std::path::Path::new(&path), size))
            .await
            .map_err(|e| e.to_string())??;
        Ok(Response::new(png))
    }

    /// Drag the items out to Explorer or another app. Blocks until the drag ends; the page's pointer events
    /// stop meanwhile. Returns the effect: 0 nothing, 1 copied, 2 moved.
    #[tauri::command]
    pub fn shelf_drag_out(app: AppHandle, ids: Vec<String>) -> Result<u32, String> {
        let paths = paths_of(&ids)?;
        if paths.is_empty() {
            return Ok(0);
        }
        let settings = settings_now();
        DRAGGING_OUT.store(true, Ordering::SeqCst);
        let _busy = Busy::on();
        let effect = native::drag_out(&paths, settings.copy_on_drag);
        DRAGGING_OUT.store(false, Ordering::SeqCst);
        let effect = effect?;
        let _ = app;
        // Auto-remove: only a drag that landed somewhere removes the items (the Mac checks `!operation.isEmpty`).
        if settings.auto_remove && effect != 0 {
            let n = with_store(|s| s.remove_many(&ids)).unwrap_or(0);
            if n > 0 {
                emit_items();
            }
        }
        Ok(effect)
    }

    /// Share through the Windows share sheet.
    #[tauri::command]
    pub fn shelf_share(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
        let paths = paths_of(&ids)?;
        share_paths(&app, paths)
    }

    pub(crate) fn share_paths(app: &AppHandle, paths: Vec<PathBuf>) -> Result<(), String> {
        if paths.is_empty() {
            return Err("nothing to share".into());
        }
        let w = notch(app)?;
        let hwnd = w.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (tx, rx) = std::sync::mpsc::channel();
        let _busy = Busy::on();
        app.run_on_main_thread(move || {
            let _ = tx.send(native::share(hwnd, &paths));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(20)).map_err(|_| "the share sheet did not open".to_string())?
    }

    /// The share tile was clicked: choose files, then share them (the Mac's `showFilePicker`).
    #[tauri::command]
    pub fn shelf_pick_and_share(app: AppHandle) -> Result<usize, String> {
        let w = notch(&app)?;
        let hwnd = w.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (tx, rx) = std::sync::mpsc::channel();
        let _busy = Busy::on();
        app.run_on_main_thread(move || {
            let _ = tx.send(native::pick_files(hwnd));
        })
        .map_err(|e| e.to_string())?;
        let picked = rx.recv().map_err(|_| "the file picker failed".to_string())??;
        let n = picked.len();
        if n > 0 {
            share_paths(&app, picked.into_iter().map(PathBuf::from).collect())?;
        }
        Ok(n)
    }

    /// The context menu (a native menu, as the Mac's NSMenu): the choice arrives as `shelf_menu`.
    #[tauri::command]
    pub fn shelf_context_menu(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
        let w = notch(&app)?;
        let kinds = with_store(|s| ids.iter().filter_map(|id| s.get(id).map(|i| (i.id.clone(), i.kind.clone()))).collect::<Vec<_>>())?;
        if kinds.is_empty() {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let _busy = Busy::on();
        app.run_on_main_thread(move || {
            let _ = tx.send(native::popup_menu(&w, &kinds));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(300)).map_err(|_| "the menu did not close".to_string())?
    }

    /// What a menu choice does when it is not handled by the page (page-only: rename).
    pub(crate) fn run_menu_action(app: &AppHandle, action: &str, ids: &[String]) {
        let r = match action {
            "open" => ids.first().map(|i| shelf_open(i.clone())).unwrap_or(Ok(())),
            "openWith" => ids.first().map(|i| shelf_open_with(i.clone())).unwrap_or(Ok(())),
            "reveal" => shelf_reveal(ids.to_vec()),
            "quickLook" => shelf_quick_look(ids.to_vec()),
            "share" => shelf_share(app.clone(), ids.to_vec()),
            "copy" => shelf_copy(ids.to_vec()),
            "copyPath" => shelf_copy_path(ids.to_vec()),
            "remove" => {
                shelf_remove(ids.to_vec());
                Ok(())
            }
            // The page does the rest (rename edits in place).
            other => {
                let _ = app.emit_to("notch", "shelf_menu", serde_json::json!({ "action": other, "ids": ids }));
                Ok(())
            }
        };
        if let Err(e) = r {
            eprintln!("relo: shelf action {action} failed: {e}");
            let _ = app.emit_to("notch", "shelf_error", e);
        }
    }
}

#[cfg(windows)]
pub use commands::*;

/// Stubs so the command list is the same on every platform (the app only ships on Windows).
#[cfg(not(windows))]
mod commands {
    macro_rules! unsupported {
        ($($name:ident($($a:ident: $t:ty),*) -> $r:ty;)*) => {$(
            #[tauri::command]
            pub fn $name($($a: $t),*) -> Result<$r, String> { Err("the shelf needs Windows".into()) }
        )*};
    }
    unsupported! {
        shelf_open(id: String) -> ();
        shelf_reveal(ids: Vec<String>) -> ();
        shelf_open_with(id: String) -> ();
        shelf_quick_look(ids: Vec<String>) -> ();
        shelf_copy_path(ids: Vec<String>) -> ();
        shelf_copy(ids: Vec<String>) -> ();
        shelf_drag_out(ids: Vec<String>) -> u32;
        shelf_share(ids: Vec<String>) -> ();
        shelf_context_menu(ids: Vec<String>) -> ();
        shelf_pick_and_share() -> usize;
    }
}
#[cfg(not(windows))]
pub use commands::*;
