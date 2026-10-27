//! YouTube Music desktop app (pear-desktop, formerly th-ch/youtube-music) through its local API plugin, the same
//! one the Mac uses (YouTubeMusicController.swift): `POST /auth/reloNotch` for a token, then `/api/v1/...` with it.
//! The app must be running with its "API Server" plugin on (default port 26538). The Mac keeps a WebSocket open; here a
//! 2 s poll runs only while this source is chosen and reachable (and backs off to 8 s when it is not).

use super::model::{data_url, now_unix_ms, MediaState, Repeat};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

const BASE: &str = "http://localhost:26538";
const APP_ID: &str = "com.github.th-ch.youtube-music";

static TOKEN: Mutex<Option<String>> = Mutex::new(None);
static ART: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

fn agent() -> ureq2::Agent {
    ureq2::AgentBuilder::new().timeout(Duration::from_secs(4)).build()
}

fn token() -> Result<String, String> {
    if let Some(t) = TOKEN.lock().unwrap().clone() {
        return Ok(t);
    }
    let v: Value = agent().post(&format!("{BASE}/auth/reloNotch")).call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
    let t = v.get("accessToken").and_then(Value::as_str).ok_or("no accessToken")?.to_string();
    *TOKEN.lock().unwrap() = Some(t.clone());
    Ok(t)
}

fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let t = token()?;
    let url = format!("{BASE}/api/v1{path}");
    let req = agent().request(method, &url).set("Authorization", &format!("Bearer {t}"));
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => Ok(r.into_json::<Value>().unwrap_or(Value::Null)),
        Err(ureq2::Error::Status(401 | 403, _)) => {
            *TOKEN.lock().unwrap() = None;
            Err("authentication required".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// `/api/v1/song` JSON (plus optional extras) to a state. Pure, tested.
pub fn parse_song(v: &Value, now_ms: i64) -> MediaState {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let f = |k: &str| v.get(k).and_then(Value::as_f64);
    let paused = v.get("isPaused").and_then(Value::as_bool).unwrap_or(true);
    let repeat = match v.get("repeatMode").and_then(Value::as_i64) {
        Some(1) => Repeat::All,
        Some(2) => Repeat::One,
        _ => Repeat::Off,
    };
    MediaState {
        active: true,
        title: s("title"),
        artist: s("artist"),
        album: s("album"),
        is_playing: !paused,
        position_ms: (f("elapsedSeconds").unwrap_or(0.0) * 1000.0) as i64,
        duration_ms: (f("songDuration").unwrap_or(0.0) * 1000.0) as i64,
        timestamp_ms: now_ms,
        rate: 1.0,
        is_shuffled: v.get("isShuffled").and_then(Value::as_bool).unwrap_or(false),
        repeat,
        can_seek: true,
        can_prev: true,
        can_next: true,
        shuffle_supported: true,
        repeat_supported: true,
        volume_supported: true,
        volume: f("volume").map(|x| (x / 100.0).clamp(0.0, 1.0)).unwrap_or(0.5),
        favorite_supported: true,
        app_id: APP_ID.into(),
        app_name: "YouTube Music".into(),
        ..Default::default()
    }
}

fn artwork(url: &str) -> Option<String> {
    if let Some((u, a)) = ART.lock().unwrap().as_ref() {
        if u == url {
            return a.clone();
        }
    }
    let got = (|| {
        let r = agent().get(url).call().ok()?;
        let mut buf = Vec::new();
        use std::io::Read;
        r.into_reader().take(4_000_000).read_to_end(&mut buf).ok()?;
        data_url(&buf)
    })();
    *ART.lock().unwrap() = Some((url.to_string(), got.clone()));
    got
}

/// One read of the app. Err = not running / not reachable / not authorised.
pub fn poll() -> Result<MediaState, String> {
    let song = request("GET", "/song", None)?;
    let mut st = parse_song(&song, now_unix_ms());
    if let Some(u) = song.get("imageSrc").and_then(Value::as_str) {
        st.artwork = artwork(u);
    }
    if let Ok(like) = request("GET", "/like-state", None) {
        st.is_favorite = like.get("state").and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case("LIKE"));
    }
    Ok(st)
}

pub fn command(name: &str, arg: Option<f64>) -> Result<(), String> {
    let (method, path, body): (&str, &str, Option<Value>) = match name {
        "play" => ("POST", "/play", None),
        "pause" => ("POST", "/pause", None),
        "toggle" => ("POST", "/toggle-play", None),
        "next" => ("POST", "/next", None),
        "prev" => ("POST", "/previous", None),
        "shuffle" => ("POST", "/shuffle", None),
        "repeat" => ("POST", "/switch-repeat", None),
        "like" => ("POST", "/like", None),
        "seek" => ("POST", "/seek-to", Some(json!({ "seconds": arg.unwrap_or(0.0) }))),
        "volume" => ("POST", "/volume", Some(json!({ "volume": (arg.unwrap_or(0.5).clamp(0.0, 1.0) * 100.0).round() as i64 }))),
        _ => return Err("unknown command".into()),
    };
    request(method, path, body).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_song_response() {
        let v = json!({"isPaused": false, "title": "T", "artist": "A", "album": "Al", "elapsedSeconds": 12.5,
                       "songDuration": 200, "repeatMode": 2, "isShuffled": true, "volume": 40});
        let s = parse_song(&v, 7);
        assert!(s.is_playing && s.is_shuffled);
        assert_eq!((s.title.as_str(), s.artist.as_str(), s.album.as_str()), ("T", "A", "Al"));
        assert_eq!((s.position_ms, s.duration_ms, s.timestamp_ms), (12_500, 200_000, 7));
        assert_eq!(s.repeat, Repeat::One);
        assert!((s.volume - 0.4).abs() < 1e-9);
    }

    #[test]
    fn missing_fields_default_to_paused() {
        let s = parse_song(&json!({}), 0);
        assert!(!s.is_playing && s.active && s.title.is_empty());
    }
}
