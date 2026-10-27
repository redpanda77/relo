//! The shelf's storage: `items.json` (atomic writes, corrupt entries discarded one by one, as the Mac's
//! ShelfPersistenceService does), `settings.json`, and temporary file storage for dropped data that has no file
//! behind it (the Mac's TemporaryFileStorageService). Everything lives under one root, %LOCALAPPDATA%\Relo\shelf:
//!   items.json, settings.json, files\<id>\<name> (temporary copies), tmp\ (drag-out stand-ins for text and links).

use super::model::{new_id, Item, Kind, Settings};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

pub struct Store {
    root: PathBuf,
    pub items: Vec<Item>,
    pub settings: Settings,
}

pub fn default_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join(crate::profile::app_dir()).join("shelf"))
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("bad path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// A file name that is safe on Windows: no separators or reserved characters, no reserved device names, no
/// trailing dots or spaces, at most 120 characters. Empty input gets a fallback.
pub fn sanitize_name(raw: &str, fallback: &str) -> String {
    let mut s: String = raw.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if s.is_empty() || s.chars().all(|c| c == '.') || reserved {
        return if s.is_empty() || s.chars().all(|c| c == '.') { fallback.to_string() } else { format!("_{s}") };
    }
    s
}

impl Store {
    pub fn open(root: PathBuf) -> Store {
        let mut s = Store { items: Vec::new(), settings: Settings::default(), root };
        s.items = s.load_items();
        s.settings = s.load_settings();
        s
    }

    fn items_path(&self) -> PathBuf {
        self.root.join("items.json")
    }
    fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }
    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }

    fn load_items(&self) -> Vec<Item> {
        let Ok(text) = std::fs::read_to_string(self.items_path()) else { return Vec::new() };
        let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else {
            let _ = std::fs::rename(self.items_path(), self.root.join("items.json.bad"));
            return Vec::new();
        };
        let arr = match &v {
            Value::Array(a) => a.clone(),
            Value::Object(o) => o.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut seen = HashSet::new();
        arr.into_iter()
            .filter_map(|e| serde_json::from_value::<Item>(e).ok())
            .filter(|i| !i.id.is_empty() && seen.insert(i.id.clone()))
            .collect()
    }

    fn load_settings(&self) -> Settings {
        std::fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|t| serde_json::from_str::<Settings>(t.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        write_atomic(&self.items_path(), &serde_json::to_string_pretty(&json!({ "version": 1, "items": self.items })).map_err(|e| e.to_string())?)
    }

    pub fn set_settings(&mut self, s: Settings) -> Result<(), String> {
        self.settings = s;
        write_atomic(&self.settings_path(), &serde_json::to_string_pretty(&self.settings).map_err(|e| e.to_string())?)
    }

    /// Add items, skipping any already on the shelf (existing first, order kept). Returns the ones actually added.
    pub fn add(&mut self, new: Vec<Item>) -> Vec<Item> {
        let mut seen: HashSet<String> = self.items.iter().map(Item::identity_key).collect();
        let mut added = Vec::new();
        for it in new {
            if seen.insert(it.identity_key()) {
                added.push(it.clone());
                self.items.push(it);
            } else {
                // A duplicate temp copy is useless: do not leave it on disk.
                self.cleanup_stored(&it);
            }
        }
        if !added.is_empty() {
            let _ = self.save();
        }
        added
    }

    pub fn get(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }

    /// Remove an item and delete its temporary copy (never anything outside the shelf's own folder).
    pub fn remove(&mut self, id: &str) -> Option<Item> {
        let idx = self.items.iter().position(|i| i.id == id)?;
        let it = self.items.remove(idx);
        self.cleanup_stored(&it);
        let _ = self.save();
        Some(it)
    }

    pub fn remove_many(&mut self, ids: &[String]) -> usize {
        let mut n = 0;
        for id in ids {
            if self.remove(id).is_some() {
                n += 1;
            }
        }
        n
    }

    /// Drop file items whose file is gone (the Mac's `cleanupInvalidItems`). Returns how many.
    pub fn retain_valid(&mut self) -> usize {
        let before = self.items.len();
        let dead: Vec<Item> = self.items.iter().filter(|i| matches!(&i.kind, Kind::File { path } if !Path::new(path).exists())).cloned().collect();
        for it in &dead {
            self.cleanup_stored(it);
        }
        self.items.retain(|i| !dead.iter().any(|d| d.id == i.id));
        if self.items.len() != before {
            let _ = self.save();
        }
        before - self.items.len()
    }

    /// True when `path` is inside this shelf's temporary file folder.
    pub fn is_stored(&self, path: &Path) -> bool {
        let Some(rel) = path.strip_prefix(self.files_dir()).ok() else { return false };
        // No `..` games: every component must be a plain name.
        rel.components().count() >= 1 && rel.components().all(|c| matches!(c, Component::Normal(_)))
    }

    fn cleanup_stored(&self, it: &Item) {
        if !it.is_temporary {
            return;
        }
        if let Kind::File { path } = &it.kind {
            self.remove_temporary_file(Path::new(path));
        }
    }

    /// Delete a temporary file and its folder once empty. Refuses anything outside `files\`.
    pub fn remove_temporary_file(&self, path: &Path) {
        if !self.is_stored(path) {
            return;
        }
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            if dir != self.files_dir() && std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }

    /// Store bytes as a temporary file: files\<id>\<name>. Returns its path.
    pub fn create_temp_file(&self, bytes: &[u8], suggested_name: Option<&str>) -> Result<PathBuf, String> {
        let name = sanitize_name(suggested_name.unwrap_or(""), "dropped.dat");
        let dir = self.files_dir().join(new_id());
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }

    /// A file for text or a link, to hand to a drag, a share or a preview: tmp\<id>\<name>.
    pub fn stand_in(&self, item: &Item) -> Result<PathBuf, String> {
        let (bytes, name): (Vec<u8>, String) = match &item.kind {
            Kind::Text { text } => {
                let first = text.trim().lines().next().unwrap_or("text");
                (text.clone().into_bytes(), format!("{}.txt", sanitize_name(&first.chars().take(40).collect::<String>(), "text")))
            }
            Kind::Link { url } => {
                let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "link".into());
                (format!("[InternetShortcut]\r\nURL={url}\r\n").into_bytes(), format!("{}.url", sanitize_name(&host, "link")))
            }
            Kind::File { path } => return Ok(PathBuf::from(path)),
        };
        let dir = self.tmp_dir().join(new_id());
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }

    /// Rename a file item on disk (same folder). The new name is checked, never a path.
    pub fn rename(&mut self, id: &str, new_name: &str) -> Result<(), String> {
        let clean = sanitize_name(new_name, "");
        if clean.is_empty() || clean != new_name.trim() {
            return Err("that name cannot be used".into());
        }
        let idx = self.items.iter().position(|i| i.id == id).ok_or("no such item")?;
        let Kind::File { path } = &self.items[idx].kind else { return Err("only files can be renamed".into()) };
        let from = PathBuf::from(path);
        let to = from.parent().ok_or("no folder")?.join(&clean);
        if to != from {
            if to.exists() {
                return Err("a file with that name already exists".into());
            }
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
        self.items[idx].kind = Kind::File { path: to.to_string_lossy().into_owned() };
        let _ = self.save();
        Ok(())
    }

    /// At startup: delete the drag-out stand-ins and any temporary folder no item refers to.
    pub fn sweep(&self) {
        let _ = std::fs::remove_dir_all(self.tmp_dir());
        let keep: HashSet<PathBuf> = self
            .items
            .iter()
            .filter(|i| i.is_temporary)
            .filter_map(|i| match &i.kind {
                Kind::File { path } => Path::new(path).parent().map(Path::to_path_buf),
                _ => None,
            })
            .collect();
        if let Ok(rd) = std::fs::read_dir(self.files_dir()) {
            for e in rd.flatten() {
                if !keep.contains(&e.path()) {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-shelf-test-{tag}-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn file_item(p: &Path) -> Item {
        Item::new(Kind::File { path: p.to_string_lossy().into_owned() }, false)
    }

    #[test]
    fn persists_across_a_restart_in_order() {
        let root = tmp("persist");
        let f = root.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let mut s = Store::open(root.join("shelf"));
        s.add(vec![file_item(&f), Item::new(Kind::Text { text: "note".into() }, false), Item::new(Kind::Link { url: "https://a.b/c".into() }, false)]);
        let ids: Vec<String> = s.items.iter().map(|i| i.id.clone()).collect();
        drop(s);
        let s2 = Store::open(root.join("shelf"));
        assert_eq!(s2.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), ids);
        assert!(matches!(s2.items[1].kind, Kind::Text { .. }));
    }

    #[test]
    fn deduplicates_and_keeps_existing_first() {
        let root = tmp("dedupe");
        let f = root.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let mut s = Store::open(root.join("shelf"));
        assert_eq!(s.add(vec![file_item(&f)]).len(), 1);
        let again = file_item(&PathBuf::from(f.to_string_lossy().to_uppercase().replace("\\", "/")));
        // different case/separators of the same path is the same item on Windows
        let n = if cfg!(windows) { 0 } else { 1 };
        assert_eq!(s.add(vec![again]).len(), n);
        assert_eq!(s.add(vec![Item::new(Kind::Text { text: "t".into() }, false), Item::new(Kind::Text { text: "t".into() }, false)]).len(), 1);
    }

    #[test]
    fn corrupt_entries_are_discarded_one_by_one() {
        let root = tmp("corrupt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("items.json"),
            r#"{"version":1,"items":[{"id":"1","kind":{"type":"text","text":"ok"}},{"id":"2","kind":{"type":"nope"}},7,{"id":"1","kind":{"type":"text","text":"dup id"}},{"id":"3","kind":{"type":"link","url":"https://x.y"}}]}"#,
        )
        .unwrap();
        let s = Store::open(root);
        assert_eq!(s.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["1", "3"]);
    }

    #[test]
    fn unreadable_file_is_set_aside_not_fatal() {
        let root = tmp("garbage");
        std::fs::write(root.join("items.json"), "not json").unwrap();
        let s = Store::open(root.clone());
        assert!(s.items.is_empty());
        assert!(root.join("items.json.bad").exists());
    }

    #[test]
    fn temporary_files_are_deleted_with_their_item_and_only_those() {
        let root = tmp("temp");
        let mut s = Store::open(root.join("shelf"));
        let p = s.create_temp_file(b"hello", Some("pic.png")).unwrap();
        assert!(p.exists() && s.is_stored(&p));
        let it = Item::new(Kind::File { path: p.to_string_lossy().into_owned() }, true);
        let id = it.id.clone();
        s.add(vec![it]);
        s.remove(&id);
        assert!(!p.exists());
        assert!(!p.parent().unwrap().exists(), "the empty folder goes too");

        // a user's own file is never deleted, even if marked temporary by a bad items.json
        let mine = root.join("mine.txt");
        std::fs::write(&mine, "keep").unwrap();
        let bad = Item::new(Kind::File { path: mine.to_string_lossy().into_owned() }, true);
        let bid = bad.id.clone();
        s.add(vec![bad]);
        s.remove(&bid);
        assert!(mine.exists());
        // and `..` cannot climb out of files\
        let sneaky = s.files_dir().join("..").join("..").join("mine.txt");
        s.remove_temporary_file(&sneaky);
        assert!(mine.exists());
    }

    #[test]
    fn missing_files_leave_the_shelf() {
        let root = tmp("missing");
        let f = root.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let mut s = Store::open(root.join("shelf"));
        s.add(vec![file_item(&f), Item::new(Kind::Text { text: "stay".into() }, false)]);
        std::fs::remove_file(&f).unwrap();
        assert_eq!(s.retain_valid(), 1);
        assert_eq!(s.items.len(), 1);
        assert_eq!(Store::open(root.join("shelf")).items.len(), 1);
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(sanitize_name("a/b\\c:d.txt", "x"), "a_b_c_d.txt");
        assert_eq!(sanitize_name("  ", "fb"), "fb");
        assert_eq!(sanitize_name("..", "fb"), "fb");
        assert_eq!(sanitize_name("name. . ", "fb"), "name");
        assert_eq!(sanitize_name("CON.txt", "fb"), "_CON.txt");
        assert_eq!(sanitize_name("com3", "fb"), "_com3");
        assert_eq!(sanitize_name(&"x".repeat(300), "fb").len(), 120);
    }

    #[test]
    fn stand_ins_for_text_and_links() {
        let root = tmp("standin");
        let s = Store::open(root.join("shelf"));
        let t = s.stand_in(&Item::new(Kind::Text { text: "Hello\nworld".into() }, false)).unwrap();
        assert!(t.to_string_lossy().ends_with("Hello.txt"));
        assert_eq!(std::fs::read_to_string(&t).unwrap(), "Hello\nworld");
        let l = s.stand_in(&Item::new(Kind::Link { url: "https://example.com/x".into() }, false)).unwrap();
        assert!(l.to_string_lossy().ends_with("example.com.url"));
        assert!(std::fs::read_to_string(&l).unwrap().contains("URL=https://example.com/x"));
    }

    #[test]
    fn rename_stays_in_the_folder_and_refuses_collisions() {
        let root = tmp("rename");
        let (a, b) = (root.join("a.txt"), root.join("b.txt"));
        std::fs::write(&a, "1").unwrap();
        std::fs::write(&b, "2").unwrap();
        let mut s = Store::open(root.join("shelf"));
        let it = file_item(&a);
        let id = it.id.clone();
        s.add(vec![it]);
        assert!(s.rename(&id, "b.txt").is_err());
        assert!(s.rename(&id, "..\\evil.txt").is_err());
        assert!(s.rename(&id, "c.txt").is_ok());
        assert!(root.join("c.txt").exists() && !a.exists());
        assert!(matches!(&s.get(&id).unwrap().kind, Kind::File { path } if path.ends_with("c.txt")));
    }

    #[test]
    fn sweep_removes_orphans_and_standins_but_keeps_referenced() {
        let root = tmp("sweep");
        let mut s = Store::open(root.join("shelf"));
        let keep = s.create_temp_file(b"1", Some("keep.bin")).unwrap();
        let orphan = s.create_temp_file(b"2", Some("orphan.bin")).unwrap();
        s.add(vec![Item::new(Kind::File { path: keep.to_string_lossy().into_owned() }, true)]);
        let st = s.stand_in(&Item::new(Kind::Text { text: "x".into() }, false)).unwrap();
        s.sweep();
        assert!(keep.exists() && !orphan.exists() && !st.exists());
    }

    #[test]
    fn settings_persist() {
        let root = tmp("settings");
        let mut s = Store::open(root.join("shelf"));
        let next = s.settings.patched(&json!({ "autoRemove": true, "copyOnDrag": true }));
        s.set_settings(next).unwrap();
        let s2 = Store::open(root.join("shelf"));
        assert!(s2.settings.auto_remove && s2.settings.copy_on_drag && s2.settings.enabled);
    }
}
