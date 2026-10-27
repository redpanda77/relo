//! The media model shared by every source, and the pure rules around it (no WinRT in here, so it is testable).
//! Mac: PlaybackState (MediaControllerProtocol.swift) + MediaControllerType (Constants.swift).

use serde::{Deserialize, Serialize};

/// Where music is read from. The Mac picks one controller in Settings; here the Apple Music and Spotify controllers
/// (AppleScript on the Mac) become filters over the Windows media sessions, and Now Playing is "whatever Windows shows".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    #[default]
    NowPlaying,
    AppleMusic,
    Spotify,
    YoutubeMusic,
}

impl Source {
    pub fn parse(s: &str) -> Source {
        match s {
            "appleMusic" => Source::AppleMusic,
            "spotify" => Source::Spotify,
            "youtubeMusic" => Source::YoutubeMusic,
            _ => Source::NowPlaying,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

impl Repeat {
    pub fn next(self) -> Repeat {
        match self {
            Repeat::Off => Repeat::All,
            Repeat::All => Repeat::One,
            Repeat::One => Repeat::Off,
        }
    }
}

/// One media session, for the "all sessions" list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrief {
    pub app_id: String,
    pub app_name: String,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub current: bool,
}

/// What the page renders. `position_ms` is the position at `timestamp_ms` (Unix ms); the page extrapolates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    /// A session of the chosen source exists.
    pub active: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub timestamp_ms: i64,
    pub rate: f64,
    pub is_shuffled: bool,
    pub repeat: Repeat,
    pub can_seek: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub shuffle_supported: bool,
    pub repeat_supported: bool,
    pub volume_supported: bool,
    /// 0..1
    pub volume: f64,
    pub favorite_supported: bool,
    pub is_favorite: bool,
    /// The source app's id (AUMID or exe) and its friendly name.
    pub app_id: String,
    pub app_name: String,
    /// `data:` URL of the cover, or None (the page then shows the app's initial, as the Mac shows the app icon).
    pub artwork: Option<String>,
    /// Every session Windows knows about, current first.
    pub sessions: Vec<SessionBrief>,
}

impl MediaState {
    /// Equality that ignores the clock, so a state that only moved in time is not re-sent.
    pub fn same_content(&self, other: &MediaState) -> bool {
        let mut a = self.clone();
        let mut b = other.clone();
        a.timestamp_ms = 0;
        b.timestamp_ms = 0;
        a == b
    }
}

// ---- Source apps ----

/// Friendly name for a media session's app id (an AUMID such as `SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify`,
/// or an exe such as `chrome.exe`).
pub fn app_name(app_id: &str) -> String {
    let id = app_id.to_ascii_lowercase();
    let table: [(&str, &str); 18] = [
        ("spotify", "Spotify"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("th-ch.youtube-music", "YouTube Music"),
        ("youtube music", "YouTube Music"),
        ("pear", "YouTube Music"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Movies & TV"),
        ("mediaplayer", "Media Player"),
        ("msedge", "Microsoft Edge"),
        ("chrome", "Google Chrome"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vlc", "VLC"),
        ("foobar", "foobar2000"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
    ];
    for (needle, name) in table {
        if id.contains(needle) {
            return name.to_string();
        }
    }
    // Fall back to the readable part: `Vendor.App_hash!Entry` -> App, `thing.exe` -> Thing.
    let base = id.rsplit(['\\', '/']).next().unwrap_or(&id);
    let base = base.split('!').next().unwrap_or(base);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    let base = base.rsplit('.').next().unwrap_or(base);
    let mut cs = base.chars();
    match cs.next() {
        Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
        None => "Media".to_string(),
    }
}

/// Does a session of `app_id` belong to `source`?
pub fn source_matches(source: Source, app_id: &str) -> bool {
    let id = app_id.to_ascii_lowercase();
    match source {
        Source::NowPlaying => true,
        Source::Spotify => id.contains("spotify"),
        Source::AppleMusic => id.contains("applemusic") || id.contains("itunes"),
        Source::YoutubeMusic => id.contains("youtube music") || id.contains("youtube-music") || id.contains("th-ch") || id.contains("pear"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub app_id: String,
    pub playing: bool,
    /// Windows' own pick of the current session.
    pub current: bool,
}

/// Which session the notch follows: for Now Playing, Windows' current session; for a named source, the first of its
/// sessions, preferring one that is playing. Returns an index into `sessions`.
pub fn pick_session(source: Source, sessions: &[SessionInfo]) -> Option<usize> {
    let candidates = || sessions.iter().enumerate().filter(|(_, s)| source_matches(source, &s.app_id));
    if source == Source::NowPlaying {
        // A playing session beats a paused "current" one only when current is not playing: music that is audible
        // is what the user means by Now Playing.
        let cur = candidates().find(|(_, s)| s.current).map(|(i, _)| i);
        if let Some(i) = cur {
            if sessions[i].playing {
                return Some(i);
            }
        }
        return candidates().find(|(_, s)| s.playing).map(|(i, _)| i).or(cur).or_else(|| candidates().map(|(i, _)| i).next());
    }
    candidates().find(|(_, s)| s.playing).map(|(i, _)| i).or_else(|| candidates().map(|(i, _)| i).next())
}

// ---- Time ----

/// Windows DateTime (100 ns ticks since 1601-01-01) to Unix milliseconds.
pub fn filetime_ticks_to_unix_ms(ticks: i64) -> i64 {
    ticks / 10_000 - 11_644_473_600_000
}

/// Position now, from a position reported at `reported_ms`: while playing it advances at `rate`, within `0..=duration`.
pub fn extrapolate_position(position_ms: i64, reported_ms: i64, now_ms: i64, rate: f64, playing: bool, duration_ms: i64) -> i64 {
    let mut p = position_ms;
    if playing && now_ms > reported_ms && rate.is_finite() {
        p += ((now_ms - reported_ms) as f64 * rate) as i64;
    }
    if duration_ms > 0 {
        p = p.min(duration_ms);
    }
    p.max(0)
}

pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Image bytes to a `data:` URL (the mime sniffed from the magic bytes), None for something that is not an image.
pub fn data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(app: &str, playing: bool, current: bool) -> SessionInfo {
        SessionInfo { app_id: app.into(), playing, current }
    }

    #[test]
    fn friendly_names() {
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"), "Apple Music");
        assert_eq!(app_name("chrome.exe"), "Google Chrome");
        assert_eq!(app_name("MSEdge"), "Microsoft Edge");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("mything.exe"), "Mything");
        assert_eq!(app_name(""), "Media");
    }

    #[test]
    fn sources_filter_sessions() {
        assert!(source_matches(Source::Spotify, "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(!source_matches(Source::Spotify, "chrome.exe"));
        assert!(source_matches(Source::AppleMusic, "AppleInc.AppleMusicWin_x!App"));
        assert!(source_matches(Source::YoutubeMusic, "com.github.th-ch.youtube-music"));
        assert!(source_matches(Source::NowPlaying, "anything"));
    }

    #[test]
    fn now_playing_prefers_audible_music() {
        let v = [s("chrome.exe", false, true), s("spotify.exe", true, false)];
        assert_eq!(pick_session(Source::NowPlaying, &v), Some(1));
        let v = [s("chrome.exe", true, true), s("spotify.exe", true, false)];
        assert_eq!(pick_session(Source::NowPlaying, &v), Some(0));
        let v = [s("chrome.exe", false, false), s("spotify.exe", false, true)];
        assert_eq!(pick_session(Source::NowPlaying, &v), Some(1));
        assert_eq!(pick_session(Source::NowPlaying, &[]), None);
    }

    #[test]
    fn named_source_ignores_others() {
        let v = [s("chrome.exe", true, true), s("spotify.exe", false, false)];
        assert_eq!(pick_session(Source::Spotify, &v), Some(1));
        assert_eq!(pick_session(Source::AppleMusic, &v), None);
    }

    #[test]
    fn position_extrapolates_only_while_playing_within_duration() {
        assert_eq!(extrapolate_position(10_000, 1_000, 3_000, 1.0, true, 100_000), 12_000);
        assert_eq!(extrapolate_position(10_000, 1_000, 3_000, 1.0, false, 100_000), 10_000);
        assert_eq!(extrapolate_position(10_000, 1_000, 3_000, 0.5, true, 100_000), 11_000);
        assert_eq!(extrapolate_position(99_000, 0, 5_000, 1.0, true, 100_000), 100_000);
        assert_eq!(extrapolate_position(-5, 0, 0, 1.0, true, 0), 0);
    }

    #[test]
    fn filetime_converts_to_unix() {
        // 1970-01-01 in FILETIME ticks.
        assert_eq!(filetime_ticks_to_unix_ms(116_444_736_000_000_000), 0);
    }

    #[test]
    fn data_urls_sniff_mime() {
        assert!(data_url(&[0x89, b'P', b'N', b'G', 1, 2]).unwrap().starts_with("data:image/png;base64,"));
        assert!(data_url(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().starts_with("data:image/jpeg;base64,"));
        assert!(data_url(b"nope").is_none());
    }

    #[test]
    fn same_content_ignores_clock() {
        let a = MediaState { title: "x".into(), timestamp_ms: 1, ..Default::default() };
        let b = MediaState { title: "x".into(), timestamp_ms: 99, ..Default::default() };
        assert!(a.same_content(&b));
        let c = MediaState { title: "y".into(), ..b.clone() };
        assert!(!a.same_content(&c));
    }

    #[test]
    fn repeat_cycles() {
        assert_eq!(Repeat::Off.next(), Repeat::All);
        assert_eq!(Repeat::All.next(), Repeat::One);
        assert_eq!(Repeat::One.next(), Repeat::Off);
    }
}
