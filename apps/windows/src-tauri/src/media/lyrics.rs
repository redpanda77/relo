//! Lyrics from LRCLIB, as the Mac does (MusicManager.fetchLyricsFromWeb): the no-auth search endpoint, the first hit,
//! plain lyrics preferred for the static line and the synced (LRC) text kept for line-by-line display.
//! Results (including "none") are cached in memory so a replayed track costs nothing.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub plain: String,
    /// Raw LRC text; the page parses it.
    pub synced: String,
}

/// Fold common Latin diacritics (the Mac's `.diacriticInsensitive`) and drop U+FFFD.
pub fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '\u{FFFD}')
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' => 'A',
            'è' | 'é' | 'ê' | 'ë' | 'ē' => 'e',
            'È' | 'É' | 'Ê' | 'Ë' | 'Ē' => 'E',
            'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
            'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' => 'I',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ø' => 'o',
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ō' | 'Ø' => 'O',
            'ù' | 'ú' | 'û' | 'ü' | 'ū' => 'u',
            'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' => 'U',
            'ñ' => 'n',
            'Ñ' => 'N',
            'ç' => 'c',
            'Ç' => 'C',
            'ý' | 'ÿ' => 'y',
            'Ý' => 'Y',
            other => other,
        })
        .collect()
}

pub fn percent_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

pub fn search_url(title: &str, artist: &str) -> String {
    format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        percent_encode(&normalize(title)),
        percent_encode(&normalize(artist))
    )
}

/// The first search hit: plain lyrics, else the synced text, as the Mac resolves them.
pub fn from_search_json(v: &Value) -> Option<Lyrics> {
    let first = v.as_array()?.first()?;
    let get = |k: &str| first.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let (plain, synced) = (get("plainLyrics"), get("syncedLyrics"));
    let plain = if plain.is_empty() { synced.clone() } else { plain };
    if plain.is_empty() && synced.is_empty() {
        return None;
    }
    Some(Lyrics { plain, synced })
}

type Key = (String, String);
static CACHE: Mutex<Option<HashMap<Key, Option<Lyrics>>>> = Mutex::new(None);
const CACHE_MAX: usize = 100;

/// Blocking; call from a worker thread.
pub fn fetch(title: &str, artist: &str) -> Option<Lyrics> {
    let key = (title.trim().to_lowercase(), artist.trim().to_lowercase());
    if let Some(hit) = CACHE.lock().unwrap().as_ref().and_then(|m| m.get(&key)) {
        return hit.clone();
    }
    let got = ureq2::get(&search_url(title, artist))
        .timeout(std::time::Duration::from_secs(8))
        .set("User-Agent", "Relo-for-Windows")
        .call()
        .ok()
        .and_then(|r| r.into_json::<Value>().ok())
        .and_then(|v| from_search_json(&v));
    let mut g = CACHE.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if m.len() >= CACHE_MAX {
        m.clear();
    }
    m.insert(key, got.clone());
    got
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_is_encoded_and_folded() {
        assert_eq!(
            search_url("Café del Mar", "Energy 52"),
            "https://lrclib.net/api/search?track_name=Cafe%20del%20Mar&artist_name=Energy%2052"
        );
    }

    #[test]
    fn first_hit_prefers_plain() {
        let v = json!([{"plainLyrics": " la la ", "syncedLyrics": "[00:01.00] la"}, {"plainLyrics": "other"}]);
        assert_eq!(from_search_json(&v), Some(Lyrics { plain: "la la".into(), synced: "[00:01.00] la".into() }));
    }

    #[test]
    fn synced_only_fills_plain_and_empty_is_none() {
        let v = json!([{"plainLyrics": "", "syncedLyrics": "[00:01.00] la"}]);
        assert_eq!(from_search_json(&v).unwrap().plain, "[00:01.00] la");
        assert_eq!(from_search_json(&json!([{}])), None);
        assert_eq!(from_search_json(&json!([])), None);
        assert_eq!(from_search_json(&json!({})), None);
    }
}
