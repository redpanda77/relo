//! Win32 side of the shelf: shell thumbnails (IShellItemImageFactory), drag OUT (DoDragDrop with a shell data
//! object), the clipboard, opening, the Windows share sheet (DataTransferManager) and the file picker.

use super::model::Kind;
use std::path::{Path, PathBuf};
use windows::core::{implement, w, Interface, BOOL, HSTRING, PCWSTR};
use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HANDLE, HWND, POINT, S_OK, SIZE};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn path_wide(p: &Path) -> Vec<u16> {
    wide(&p.to_string_lossy())
}

/// Make sure this thread can use COM. Errors (already initialised another way) are fine.
pub fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

// ---- Thumbnails ----

/// The shell's thumbnail for a file (or its icon when it has none), as a premultiplied BGRA bitmap.
fn shell_image(path: &Path, size: i32) -> Result<HBITMAP, String> {
    unsafe {
        com_init();
        let w = path_wide(path);
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).map_err(|e| e.to_string())?;
        factory.GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK).map_err(|e| e.to_string())
    }
}

fn bitmap_rgba(hbm: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    unsafe {
        let mut bm = BITMAP::default();
        if GetObjectW(hbm.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
            return Err("could not read the thumbnail".into());
        }
        let (w, h) = (bm.bmWidth.max(1), bm.bmHeight.abs().max(1));
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        let got = GetDIBits(dc, hbm, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        if got == 0 {
            return Err("could not read the thumbnail".into());
        }
        Ok((w as u32, h as u32, unpremultiply_bgra(buf)))
    }
}

/// BGRA, alpha premultiplied (what the shell returns) to straight RGBA. A bitmap with no alpha at all is opaque.
pub fn unpremultiply_bgra(mut px: Vec<u8>) -> Vec<u8> {
    let opaque = px.chunks_exact(4).all(|p| p[3] == 0);
    for p in px.chunks_exact_mut(4) {
        let (b, g, r) = (p[0], p[1], p[2]);
        let a = if opaque { 255 } else { p[3] };
        let un = |c: u8| if a == 0 || a == 255 { c } else { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 };
        p[0] = un(r);
        p[1] = un(g);
        p[2] = un(b);
        p[3] = a;
    }
    px
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn thumbnail_png(path: &Path, size: i32) -> Result<Vec<u8>, String> {
    let hbm = shell_image(path, size)?;
    let r = bitmap_rgba(hbm);
    unsafe {
        let _ = DeleteObject(hbm.into());
    }
    let (w, h, px) = r?;
    encode_png(w, h, &px)
}

// ---- Shell data object for files ----

/// CF_HDROP bytes for a file list: a DROPFILES header, then each path as UTF-16 with a NUL, and a final NUL.
pub fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&20u32.to_le_bytes()); // pFiles: offset of the list
    b.extend_from_slice(&[0u8; 8]); // pt
    b.extend_from_slice(&0u32.to_le_bytes()); // fNC
    b.extend_from_slice(&1u32.to_le_bytes()); // fWide
    for p in paths {
        for u in p.to_string_lossy().encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        b.extend_from_slice(&0u16.to_le_bytes());
    }
    b.extend_from_slice(&0u16.to_le_bytes());
    b
}

/// A data object that offers the files as CF_HDROP (what Explorer, browsers and chat apps read) and keeps anything
/// else the drag-image helper stores in a shell data object behind it.
#[implement(IDataObject)]
struct Files {
    hdrop: Vec<u8>,
    inner: IDataObject,
}

fn is_hdrop(f: &FORMATETC) -> bool {
    f.cfFormat == CF_HDROP.0 && (f.tymed & TYMED_HGLOBAL.0 as u32) != 0 && f.dwAspect == DVASPECT_CONTENT.0
}

impl IDataObject_Impl for Files_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        unsafe {
            let f = &*pformatetcin;
            if !is_hdrop(f) {
                return self.inner.GetData(pformatetcin);
            }
            let mem = GlobalAlloc(GMEM_MOVEABLE, self.hdrop.len())?;
            let p = GlobalLock(mem) as *mut u8;
            if p.is_null() {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
            }
            std::ptr::copy_nonoverlapping(self.hdrop.as_ptr(), p, self.hdrop.len());
            let _ = GlobalUnlock(mem);
            let mut m = STGMEDIUM::default();
            m.tymed = TYMED_HGLOBAL.0 as u32;
            m.u.hGlobal = mem;
            Ok(m)
        }
    }
    fn GetDataHere(&self, pformatetc: *const FORMATETC, pmedium: *mut STGMEDIUM) -> windows::core::Result<()> {
        unsafe { self.inner.GetDataHere(pformatetc, pmedium) }
    }
    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> windows::core::HRESULT {
        unsafe {
            if is_hdrop(&*pformatetc) {
                S_OK
            } else {
                self.inner.QueryGetData(pformatetc)
            }
        }
    }
    fn GetCanonicalFormatEtc(&self, _in: *const FORMATETC, out: *mut FORMATETC) -> windows::core::HRESULT {
        unsafe {
            (*out).ptd = std::ptr::null_mut();
        }
        windows::Win32::Foundation::DATA_S_SAMEFORMATETC
    }
    fn SetData(&self, pformatetc: *const FORMATETC, pmedium: *const STGMEDIUM, frelease: BOOL) -> windows::core::Result<()> {
        unsafe { self.inner.SetData(pformatetc, pmedium, frelease.as_bool()) }
    }
    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        unsafe {
            if dwdirection == DATADIR_GET.0 as u32 {
                let f = [FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 }];
                SHCreateStdEnumFmtEtc(&f)
            } else {
                self.inner.EnumFormatEtc(dwdirection)
            }
        }
    }
    fn DAdvise(&self, _f: *const FORMATETC, _a: u32, _s: windows::core::Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
        Err(windows::core::Error::from(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED))
    }
    fn DUnadvise(&self, _c: u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED))
    }
    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(windows::core::Error::from(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED))
    }
}

fn file_data_object(paths: &[PathBuf]) -> Result<IDataObject, String> {
    unsafe {
        com_init();
        // An empty shell data object stores what the drag-image helper sets on it.
        let inner: IDataObject = SHCreateDataObject(None, None, None::<&IDataObject>).map_err(|e| e.to_string())?;
        Ok(Files { hdrop: hdrop_bytes(paths), inner }.into())
    }
}

// ---- Drag out ----

#[implement(IDropSource)]
struct Source;

impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> windows::core::HRESULT {
        if fescapepressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    fn GiveFeedback(&self, _effect: DROPEFFECT) -> windows::core::HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Start a drag of the files and block until it ends. Returns the effect (0 none, 1 copy, 2 move). `copy_only`
/// is the Mac's "Copy items on drag". The first file's thumbnail is the drag image.
pub fn drag_out(paths: &[PathBuf], copy_only: bool) -> Result<u32, String> {
    unsafe {
        let _ = OleInitialize(None);
        let data = file_data_object(paths)?;
        if let Ok(hbm) = shell_image(&paths[0], 96) {
            let mut bm = BITMAP::default();
            GetObjectW(hbm.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
            let helper: windows::core::Result<IDragSourceHelper> = CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER);
            let used = match helper {
                Ok(h) => {
                    let img = SHDRAGIMAGE {
                        sizeDragImage: SIZE { cx: bm.bmWidth, cy: bm.bmHeight.abs() },
                        ptOffset: POINT { x: bm.bmWidth / 2, y: bm.bmHeight.abs() / 2 },
                        hbmpDragImage: hbm,
                        crColorKey: windows::Win32::Foundation::COLORREF(0xFFFF_FFFF),
                    };
                    h.InitializeFromBitmap(&img, &data).is_ok()
                }
                Err(_) => false,
            };
            if !used {
                let _ = DeleteObject(hbm.into());
            }
        }
        let source: IDropSource = Source.into();
        let ok = if copy_only { DROPEFFECT_COPY } else { DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0) };
        let mut effect = DROPEFFECT_NONE;
        let hr = DoDragDrop(&data, &source, ok, &mut effect);
        if hr != DRAGDROP_S_DROP && hr != DRAGDROP_S_CANCEL && hr.is_err() {
            return Err(format!("the drag failed ({hr:?})"));
        }
        Ok(effect.0)
    }
}

// ---- Clipboard ----

pub fn clipboard_files(paths: &[PathBuf]) -> Result<(), String> {
    unsafe {
        let _ = OleInitialize(None);
        let data = file_data_object(paths)?;
        OleSetClipboard(&data).map_err(|e| e.to_string())?;
        let _ = OleFlushClipboard();
        Ok(())
    }
}

pub fn clipboard_text(text: &str) -> Result<(), String> {
    unsafe {
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = units.len() * 2;
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?;
        let p = GlobalLock(mem) as *mut u16;
        if p.is_null() {
            return Err("clipboard memory".into());
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), p, units.len());
        let _ = GlobalUnlock(mem);
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let _ = EmptyClipboard();
        let r = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(mem.0)));
        let _ = CloseClipboard();
        r.map(|_| ()).map_err(|e| e.to_string())
    }
}

// ---- Opening ----

fn shell_execute(verb: PCWSTR, target: &str, params: Option<&str>) -> Result<(), String> {
    unsafe {
        let t = wide(target);
        let p = params.map(wide);
        let r = ShellExecuteW(None, verb, PCWSTR(t.as_ptr()), p.as_ref().map(|p| PCWSTR(p.as_ptr())).unwrap_or(PCWSTR::null()), PCWSTR::null(), SW_SHOWNORMAL);
        if r.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("could not open {target} (code {})", r.0 as isize))
        }
    }
}

pub fn open_path(path: &str) -> Result<(), String> {
    shell_execute(w!("open"), path, None)
}

pub fn open_with(path: &str) -> Result<(), String> {
    shell_execute(w!("openas"), path, None)
}

/// http(s) links only: a dropped `file:` or script URL must not run.
pub fn open_link(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|_| "not a web address".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("only web links can be opened".into());
    }
    shell_execute(w!("open"), u.as_str(), None)
}

pub fn reveal(path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    if s.contains('"') {
        return Err("bad path".into());
    }
    shell_execute(w!("open"), "explorer.exe", Some(&format!("/select,\"{s}\"")))
}

// ---- Share sheet ----

pub fn share(hwnd: isize, paths: &[PathBuf]) -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows_collections::IIterable;
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    unsafe {
        let mut items: Vec<IStorageItem> = Vec::new();
        for p in paths {
            let f = StorageFile::GetFileFromPathAsync(&HSTRING::from(p.to_string_lossy().as_ref())).and_then(|op| op.get());
            if let Ok(f) = f {
                items.push(f.cast::<IStorageItem>().map_err(|e| e.to_string())?);
            }
        }
        if items.is_empty() {
            return Err("none of these can be shared".into());
        }
        let hwnd = HWND(hwnd as _);
        let interop: IDataTransferManagerInterop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>().map_err(|e| e.to_string())?;
        let dtm: DataTransferManager = interop.GetForWindow(hwnd).map_err(|e| e.to_string())?;
        // StorageFile objects are agile WinRT objects; the handler runs on this thread's apartment.
        struct SendItems(Vec<IStorageItem>);
        unsafe impl Send for SendItems {}
        impl SendItems {
            fn get(&self) -> &Vec<IStorageItem> {
                &self.0
            }
        }
        let items = SendItems(items);
        let title = if items.0.len() == 1 { "Relo shelf item" } else { "Relo shelf items" };
        let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let req = args.Request()?;
                let data = req.Data()?;
                data.Properties()?.SetTitle(&HSTRING::from(title))?;
                let iterable: IIterable<IStorageItem> = items.get().iter().cloned().map(Some).collect::<Vec<_>>().into();
                data.SetStorageItemsReadOnly(&iterable)?;
            }
            Ok(())
        });
        let token = dtm.DataRequested(&handler).map_err(|e| e.to_string())?;
        let shown = interop.ShowShareUIForWindow(hwnd).map_err(|e| e.to_string());
        // The handler runs once the sheet asks for data; keep it registered a while, then let go.
        struct Later(DataTransferManager, i64);
        unsafe impl Send for Later {}
        impl Later {
            fn run(self) {
                std::thread::sleep(std::time::Duration::from_secs(120));
                let _ = self.0.RemoveDataRequested(self.1);
            }
        }
        let later = Later(dtm, token);
        std::thread::spawn(move || later.run());
        shown
    }
}

// ---- File picker ----

pub fn pick_files(hwnd: isize) -> Result<Vec<String>, String> {
    unsafe {
        com_init();
        let dlg: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let opts = dlg.GetOptions().map_err(|e| e.to_string())?;
        dlg.SetOptions(opts | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST).map_err(|e| e.to_string())?;
        let _ = dlg.SetTitle(w!("Share files"));
        let _unused: [COMDLG_FILTERSPEC; 0] = [];
        if dlg.Show(Some(HWND(hwnd as _))).is_err() {
            return Ok(Vec::new()); // cancelled
        }
        let results = dlg.GetResults().map_err(|e| e.to_string())?;
        let n = results.GetCount().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..n {
            let item = results.GetItemAt(i).map_err(|e| e.to_string())?;
            if let Ok(name) = item.GetDisplayName(SIGDN_FILESYSPATH) {
                out.push(name.to_string().map_err(|e| e.to_string())?);
                CoTaskMemFree(Some(name.0 as *const _));
            }
        }
        Ok(out)
    }
}

// ---- Context menu ----

use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, WebviewWindow};

/// The items the open menu acts on.
static MENU_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const PREFIX: &str = "shelf:";

/// The menu for a selection, as the Mac's (ShelfItemViewModel.presentContextMenu): Open, Open With, Show in
/// Explorer, Quick Look, Share, Rename, Copy, Copy Path, Remove. Image Actions and Compress are not ported.
pub fn menu_entries(kinds: &[Kind]) -> Vec<Option<(&'static str, &'static str)>> {
    let files = kinds.iter().filter(|k| matches!(k, Kind::File { .. })).count();
    let single = kinds.len() == 1;
    let mut m: Vec<Option<(&'static str, &'static str)>> = Vec::new();
    m.push(Some(("open", "Open")));
    if single && files == 1 {
        m.push(Some(("openWith", "Open With...")));
    }
    if files > 0 {
        m.push(Some(("reveal", "Show in Explorer")));
    }
    m.push(Some(("quickLook", "Quick Look")));
    m.push(None);
    m.push(Some(("share", "Share...")));
    m.push(None);
    if single && files == 1 {
        m.push(Some(("rename", "Rename")));
    }
    m.push(Some(("copy", "Copy")));
    if files > 0 {
        m.push(Some(("copyPath", "Copy Path")));
    }
    m.push(None);
    m.push(Some(("remove", "Remove")));
    m
}

pub fn popup_menu(w: &WebviewWindow, items: &[(String, Kind)]) -> Result<(), String> {
    use tauri::menu::ContextMenu;
    let kinds: Vec<Kind> = items.iter().map(|(_, k)| k.clone()).collect();
    *MENU_IDS.lock().unwrap() = items.iter().map(|(id, _)| id.clone()).collect();
    let app = tauri::Manager::app_handle(w);
    let mut b = MenuBuilder::new(app);
    for e in menu_entries(&kinds) {
        match e {
            Some((id, label)) => {
                b = b.item(&MenuItemBuilder::with_id(format!("{PREFIX}{id}"), label).build(app).map_err(|e| e.to_string())?);
            }
            None => b = b.separator(),
        }
    }
    let menu: Menu<_> = b.build().map_err(|e| e.to_string())?;
    menu.popup(w.as_ref().window().clone()).map_err(|e| e.to_string())
}

pub fn install_menu_events(app: &AppHandle) {
    app.on_menu_event(|app, ev| {
        let id = ev.id().0.as_str();
        let Some(action) = id.strip_prefix(PREFIX) else { return };
        let ids = MENU_IDS.lock().unwrap().clone();
        let app = app.clone();
        let action = action.to_string();
        std::thread::spawn(move || super::run_menu_action(&app, &action, &ids));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpremultiply_restores_colour_and_keeps_opaque() {
        // half-transparent red, premultiplied: B=0 G=0 R=64 A=128 -> R ~ 127
        let out = unpremultiply_bgra(vec![0, 0, 64, 128]);
        assert_eq!(out[3], 128);
        assert!((out[0] as i32 - 127).abs() <= 1 && out[1] == 0 && out[2] == 0);
        // opaque pixel: BGR swapped to RGB only
        assert_eq!(unpremultiply_bgra(vec![1, 2, 3, 255]), vec![3, 2, 1, 255]);
        // no alpha channel anywhere: treated as opaque
        assert_eq!(unpremultiply_bgra(vec![10, 20, 30, 0, 40, 50, 60, 0]), vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn hdrop_lists_wide_paths_after_the_header() {
        let b = hdrop_bytes(&[PathBuf::from("C:/a.txt"), PathBuf::from("C:/b c.png")]);
        assert_eq!(u32::from_le_bytes(b[..4].try_into().unwrap()), 20);
        assert_eq!(u32::from_le_bytes(b[16..20].try_into().unwrap()), 1, "wide");
        let units: Vec<u16> = b[20..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let text = String::from_utf16(&units).unwrap();
        assert_eq!(text, "C:/a.txt C:/b c.png  ");
    }

    #[test]
    fn png_encodes_with_the_signature() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 128]).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn menu_depends_on_the_selection() {
        let file = Kind::File { path: "C:\\a".into() };
        let text = Kind::Text { text: "t".into() };
        let ids = |k: &[Kind]| menu_entries(k).into_iter().flatten().map(|(i, _)| i).collect::<Vec<_>>();
        let one = ids(&[file.clone()]);
        assert!(one.contains(&"openWith") && one.contains(&"rename") && one.contains(&"reveal") && one.contains(&"copyPath"));
        let two = ids(&[file.clone(), file.clone()]);
        assert!(!two.contains(&"rename") && !two.contains(&"openWith") && two.contains(&"reveal"));
        let t = ids(&[text]);
        assert!(!t.contains(&"reveal") && !t.contains(&"copyPath") && t.contains(&"remove") && t.contains(&"share"));
    }
}
