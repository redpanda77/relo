//! The shelf's data: items (a file, a piece of text or a link), the shelf settings and the names shown for them.
//! Pure and cross-platform. Mirrors boringNotch Shelf/Models/ShelfItem.swift: the Mac keeps a security-scoped
//! bookmark for a file; here the file is its path (a moved file is gone from the shelf, see `Store::retain_valid`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Kind {
    File { path: String },
    Text { text: String },
    Link { url: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    /// A copy the shelf made itself (dropped data with no file behind it); deleted when the item leaves the shelf.
    #[serde(default)]
    pub is_temporary: bool,
    #[serde(default)]
    pub added_ms: u64,
}

impl Item {
    pub fn new(kind: Kind, is_temporary: bool) -> Self {
        Self { id: new_id(), kind, is_temporary, added_ms: now_ms() }
    }

    /// Two items with the same key are the same thing on the shelf (the Mac's `identityKey`).
    pub fn identity_key(&self) -> String {
        match &self.kind {
            Kind::File { path } => format!("file://{}", normalize_path(path)),
            Kind::Link { url } => format!("link://{url}"),
            Kind::Text { text } => format!("text://{text}"),
        }
    }

    pub fn display_name(&self) -> String {
        match &self.kind {
            Kind::File { path } => file_name_of(path),
            Kind::Text { text } => text.trim().to_string(),
            Kind::Link { url } => link_name(url),
        }
    }
}

/// What the page gets: an item plus what only the disk knows.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: String,
    /// "file" | "text" | "link"
    pub kind: &'static str,
    pub name: String,
    pub path: Option<String>,
    pub text: Option<String>,
    pub url: Option<String>,
    pub is_temporary: bool,
    pub is_dir: bool,
    pub missing: bool,
    pub added_ms: u64,
}

impl Item {
    pub fn view(&self) -> ItemView {
        let (kind, path, text, url) = match &self.kind {
            Kind::File { path } => ("file", Some(path.clone()), None, None),
            Kind::Text { text } => ("text", None, Some(text.clone()), None),
            Kind::Link { url } => ("link", None, None, Some(url.clone())),
        };
        let (is_dir, missing) = match &self.kind {
            Kind::File { path } => {
                let p = std::path::Path::new(path);
                (p.is_dir(), !p.exists())
            }
            _ => (false, false),
        };
        ItemView { id: self.id.clone(), kind, name: self.display_name(), path, text, url, is_temporary: self.is_temporary, is_dir, missing, added_ms: self.added_ms }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A process-unique, time-ordered id; 32 hex digits like a UUID without dashes.
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("{:016x}{:08x}{:08x}", (t as u64) ^ (pid << 40) as u64, n as u32, (t >> 64) as u32 ^ (t as u32).rotate_left(13))
}

/// Case-insensitive, one separator style, no `\\?\` prefix: Windows paths compare like this.
pub fn normalize_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub fn file_name_of(path: &str) -> String {
    let p = path.trim_end_matches(['\\', '/']);
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}

/// A link without its scheme, as the Mac shows it (`https://x.com/a` is `x.com/a`).
pub fn link_name(url: &str) -> String {
    for p in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(p) {
            return rest.to_string();
        }
    }
    url.to_string()
}

/// Dropped text that is only an http(s) address is a link.
pub fn as_link(text: &str) -> Option<String> {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    let ok = (lower.starts_with("http://") || lower.starts_with("https://")) && !t.chars().any(|c| c.is_whitespace() || c.is_control()) && t.len() <= 4096;
    if ok && url::Url::parse(t).is_ok() {
        Some(t.to_string())
    } else {
        None
    }
}

// ---- Settings ----

/// The Mac's Shelf defaults (Constants.swift): `boringShelf`, `openShelfByDefault`, `expandedDragDetection`,
/// `copyOnDrag`, `autoRemoveShelfItems`, `shelfTapToOpen`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub open_by_default: bool,
    pub expanded_drag_detection: bool,
    pub copy_on_drag: bool,
    pub auto_remove: bool,
    pub tap_to_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true, open_by_default: true, expanded_drag_detection: true, copy_on_drag: false, auto_remove: false, tap_to_open: true }
    }
}

impl Settings {
    /// Merge a partial object: only known keys holding a boolean change anything.
    pub fn patched(&self, patch: &Value) -> Settings {
        let mut s = self.clone();
        let Some(o) = patch.as_object() else { return s };
        let b = |k: &str, cur: bool| o.get(k).and_then(Value::as_bool).unwrap_or(cur);
        s.enabled = b("enabled", s.enabled);
        s.open_by_default = b("openByDefault", s.open_by_default);
        s.expanded_drag_detection = b("expandedDragDetection", s.expanded_drag_detection);
        s.copy_on_drag = b("copyOnDrag", s.copy_on_drag);
        s.auto_remove = b("autoRemove", s.auto_remove);
        s.tap_to_open = b("tapToOpen", s.tap_to_open);
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_follow_the_mac() {
        assert_eq!(Item::new(Kind::Link { url: "https://example.com/a".into() }, false).display_name(), "example.com/a");
        assert_eq!(Item::new(Kind::Link { url: "http://example.com".into() }, false).display_name(), "example.com");
        assert_eq!(Item::new(Kind::Link { url: "ftp://h/x".into() }, false).display_name(), "ftp://h/x");
        assert_eq!(Item::new(Kind::Text { text: "  hello \n".into() }, false).display_name(), "hello");
        assert_eq!(Item::new(Kind::File { path: r"C:\Users\me\Pic.PNG".into() }, false).display_name(), "Pic.PNG");
        assert_eq!(file_name_of(r"C:\dir\sub\"), "sub");
    }

    #[test]
    fn identity_ignores_case_and_separators_of_paths() {
        let a = Item::new(Kind::File { path: r"C:\Users\Me\a.txt".into() }, false);
        let b = Item::new(Kind::File { path: "c:/users/me/A.TXT".into() }, true);
        assert_eq!(a.identity_key(), b.identity_key());
        let c = Item::new(Kind::File { path: r"\\?\C:\Users\Me\a.txt".into() }, false);
        assert_eq!(a.identity_key(), c.identity_key());
        assert_ne!(a.identity_key(), Item::new(Kind::Text { text: "x".into() }, false).identity_key());
    }

    #[test]
    fn ids_are_unique() {
        let ids: std::collections::HashSet<String> = (0..2000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 2000);
        assert!(ids.iter().all(|i| i.len() == 32 && i.bytes().all(|b| b.is_ascii_hexdigit())));
    }

    #[test]
    fn dropped_text_that_is_an_address_is_a_link() {
        assert_eq!(as_link(" https://example.com/x?y=1 \n").as_deref(), Some("https://example.com/x?y=1"));
        assert_eq!(as_link("see https://example.com"), None);
        assert_eq!(as_link("javascript:alert(1)"), None);
        assert_eq!(as_link("hello"), None);
    }

    #[test]
    fn settings_default_like_the_mac_and_patch_only_known_booleans() {
        let d = Settings::default();
        assert!(d.enabled && d.open_by_default && d.expanded_drag_detection && d.tap_to_open);
        assert!(!d.copy_on_drag && !d.auto_remove);
        let p = d.patched(&json!({ "copyOnDrag": true, "autoRemove": "yes", "bogus": true, "enabled": false }));
        assert!(p.copy_on_drag && !p.enabled && !p.auto_remove);
        assert_eq!(d.patched(&json!(5)), d);
    }

    #[test]
    fn settings_read_with_missing_fields() {
        let s: Settings = serde_json::from_str(r#"{"autoRemove":true}"#).unwrap();
        assert!(s.auto_remove && s.enabled);
    }

    #[test]
    fn items_round_trip_and_tolerate_missing_optional_fields() {
        let it = Item::new(Kind::File { path: r"C:\a.txt".into() }, true);
        let back: Item = serde_json::from_str(&serde_json::to_string(&it).unwrap()).unwrap();
        assert_eq!(it, back);
        let min: Item = serde_json::from_value(json!({ "id": "x", "kind": { "type": "text", "text": "t" } })).unwrap();
        assert!(!min.is_temporary);
    }
}
