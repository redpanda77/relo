//! Windows media sessions (GlobalSystemMediaTransportControlsSessionManager): the Mac's NowPlayingController, with
//! the Apple Music and Spotify controllers as source filters. Event driven: the manager and every session tell this
//! thread when something changed; it debounces, reads the session once and publishes. No timer, no polling. The page
//! extrapolates the position between events.

use super::model::*;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::*;
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

#[derive(Debug, Clone, Copy)]
pub enum Cmd {
    Toggle,
    Play,
    Pause,
    Next,
    Prev,
    Seek(f64),
    Shuffle,
    Repeat,
}

pub enum Msg {
    /// A property of a session changed.
    Changed,
    /// The session list or the current session changed (re-subscribe).
    Sessions,
    Cmd(Cmd),
}

type Mgr = GlobalSystemMediaTransportControlsSessionManager;
type Sess = GlobalSystemMediaTransportControlsSession;

struct Sub {
    session: Sess,
    tokens: [i64; 3],
}

static ART: Mutex<Option<(String, String)>> = Mutex::new(None);

pub fn spawn(app: AppHandle, tx: Sender<Msg>, rx: Receiver<Msg>) {
    std::thread::Builder::new()
        .name("relo-media-smtc".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            if let Err(e) = run(&app, tx, rx) {
                eprintln!("relo: media sessions unavailable: {e}");
            }
        })
        .ok();
}

fn run(app: &AppHandle, tx: Sender<Msg>, rx: Receiver<Msg>) -> windows::core::Result<()> {
    let mgr = Mgr::RequestAsync()?.get()?;
    let t1 = tx.clone();
    mgr.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t1.send(Msg::Sessions);
        Ok(())
    }))?;
    let t2 = tx.clone();
    mgr.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t2.send(Msg::Sessions);
        Ok(())
    }))?;

    let mut subs: Vec<Sub> = Vec::new();
    resubscribe(&mgr, &mut subs, &tx);
    super::set_smtc(app, read_state(&mgr));

    while let Ok(first) = rx.recv() {
        let mut resub = false;
        let mut cmds = Vec::new();
        let mut take = |m: Msg| match m {
            Msg::Sessions => resub = true,
            Msg::Cmd(c) => cmds.push(c),
            Msg::Changed => {}
        };
        take(first);
        // Debounce: a track change fires several events in a burst.
        while let Ok(m) = rx.recv_timeout(Duration::from_millis(60)) {
            take(m);
        }
        if resub {
            resubscribe(&mgr, &mut subs, &tx);
        }
        for c in cmds {
            exec(&mgr, c);
        }
        super::set_smtc(app, read_state(&mgr));
    }
    Ok(())
}

fn resubscribe(mgr: &Mgr, subs: &mut Vec<Sub>, tx: &Sender<Msg>) {
    for s in subs.drain(..) {
        let _ = s.session.RemoveMediaPropertiesChanged(s.tokens[0]);
        let _ = s.session.RemovePlaybackInfoChanged(s.tokens[1]);
        let _ = s.session.RemoveTimelinePropertiesChanged(s.tokens[2]);
    }
    let Ok(list) = mgr.GetSessions() else { return };
    for session in list {
        let (a, b, c) = (tx.clone(), tx.clone(), tx.clone());
        let t0 = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = a.send(Msg::Changed);
            Ok(())
        }));
        let t1 = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = b.send(Msg::Changed);
            Ok(())
        }));
        let t2 = session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = c.send(Msg::Changed);
            Ok(())
        }));
        if let (Ok(t0), Ok(t1), Ok(t2)) = (t0, t1, t2) {
            subs.push(Sub { session, tokens: [t0, t1, t2] });
        }
    }
}

fn app_id(s: &Sess) -> String {
    s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
}

fn is_playing(s: &Sess) -> bool {
    s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(|p| p == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing).unwrap_or(false)
}

/// The session the notch follows, with the list of all of them.
fn pick(mgr: &Mgr) -> (Vec<Sess>, Vec<SessionInfo>, Option<usize>) {
    let sessions: Vec<Sess> = mgr.GetSessions().map(|l| l.into_iter().collect()).unwrap_or_default();
    let cur = mgr.GetCurrentSession().ok().map(|s| app_id(&s));
    let infos: Vec<SessionInfo> = sessions
        .iter()
        .map(|s| {
            let id = app_id(s);
            SessionInfo { current: cur.as_deref() == Some(id.as_str()), playing: is_playing(s), app_id: id }
        })
        .collect();
    let idx = pick_session(super::source(), &infos);
    (sessions, infos, idx)
}

fn read_state(mgr: &Mgr) -> MediaState {
    let (sessions, infos, idx) = pick(mgr);
    let mut briefs: Vec<SessionBrief> = Vec::new();
    for (s, i) in sessions.iter().zip(&infos) {
        let (title, artist) = s
            .TryGetMediaPropertiesAsync()
            .and_then(|a| a.get())
            .map(|p| (p.Title().map(|t| t.to_string()).unwrap_or_default(), p.Artist().map(|t| t.to_string()).unwrap_or_default()))
            .unwrap_or_default();
        briefs.push(SessionBrief { app_name: app_name(&i.app_id), app_id: i.app_id.clone(), playing: i.playing, title, artist, current: Some(briefs.len()) == idx });
    }
    let Some(i) = idx else {
        return MediaState { sessions: briefs, ..Default::default() };
    };
    read_session(&sessions[i], &infos[i].app_id, briefs).unwrap_or_default()
}

fn read_session(s: &Sess, id: &str, briefs: Vec<SessionBrief>) -> windows::core::Result<MediaState> {
    let props = s.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let album = props.AlbumTitle().map(|t| t.to_string()).unwrap_or_default();
    let info = s.GetPlaybackInfo()?;
    let playing = info.PlaybackStatus()? == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
    let controls = info.Controls()?;
    let rate = info.PlaybackRate().ok().and_then(|r| r.Value().ok()).unwrap_or(1.0);
    let shuffle = info.IsShuffleActive().ok().and_then(|r| r.Value().ok());
    let repeat = info.AutoRepeatMode().ok().and_then(|r| r.Value().ok());

    let now = now_unix_ms();
    let (mut position_ms, mut duration_ms) = (0, 0);
    if let Ok(t) = s.GetTimelineProperties() {
        let start = t.StartTime().map(|d| d.Duration).unwrap_or(0);
        let end = t.EndTime().map(|d| d.Duration).unwrap_or(0);
        let pos = t.Position().map(|d| d.Duration).unwrap_or(0);
        duration_ms = ((end - start) / 10_000).max(0);
        let raw = ((pos - start) / 10_000).max(0);
        let reported = t.LastUpdatedTime().map(|d| filetime_ticks_to_unix_ms(d.UniversalTime)).unwrap_or(now);
        let reported = if reported <= 0 || reported > now { now } else { reported };
        position_ms = extrapolate_position(raw, reported, now, rate, playing, duration_ms);
    }

    let key = format!("{id}\u{1}{title}\u{1}{artist}\u{1}{album}");
    let cached = ART.lock().unwrap().as_ref().filter(|(k, _)| *k == key).map(|(_, a)| a.clone());
    let artwork = cached.or_else(|| {
        let a = thumbnail(&props)?;
        *ART.lock().unwrap() = Some((key, a.clone()));
        Some(a)
    });

    Ok(MediaState {
        active: true,
        title,
        artist,
        album,
        is_playing: playing,
        position_ms,
        duration_ms,
        timestamp_ms: now,
        rate: if rate > 0.0 { rate } else { 1.0 },
        is_shuffled: shuffle.unwrap_or(false),
        repeat: match repeat {
            Some(MediaPlaybackAutoRepeatMode::Track) => Repeat::One,
            Some(MediaPlaybackAutoRepeatMode::List) => Repeat::All,
            _ => Repeat::Off,
        },
        can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false) && duration_ms > 0,
        can_prev: controls.IsPreviousEnabled().unwrap_or(true),
        can_next: controls.IsNextEnabled().unwrap_or(true),
        shuffle_supported: shuffle.is_some() && controls.IsShuffleEnabled().unwrap_or(false),
        repeat_supported: repeat.is_some() && controls.IsRepeatEnabled().unwrap_or(false),
        app_name: app_name(id),
        app_id: id.to_string(),
        artwork,
        sessions: briefs,
        ..Default::default()
    })
}

fn thumbnail(props: &GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as usize;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut buf = vec![0u8; size];
    reader.ReadBytes(&mut buf).ok()?;
    data_url(&buf)
}

fn exec(mgr: &Mgr, c: Cmd) {
    let (sessions, _, idx) = pick(mgr);
    let Some(s) = idx.map(|i| &sessions[i]) else { return };
    let _ = match c {
        Cmd::Toggle => s.TryTogglePlayPauseAsync().and_then(|a| a.get()),
        Cmd::Play => s.TryPlayAsync().and_then(|a| a.get()),
        Cmd::Pause => s.TryPauseAsync().and_then(|a| a.get()),
        Cmd::Next => s.TrySkipNextAsync().and_then(|a| a.get()),
        Cmd::Prev => s.TrySkipPreviousAsync().and_then(|a| a.get()),
        Cmd::Seek(sec) => {
            let start = s.GetTimelineProperties().and_then(|t| t.StartTime()).map(|d| d.Duration).unwrap_or(0);
            s.TryChangePlaybackPositionAsync(start + (sec.max(0.0) * 1e7) as i64).and_then(|a| a.get())
        }
        Cmd::Shuffle => {
            let cur = s.GetPlaybackInfo().and_then(|i| i.IsShuffleActive()).and_then(|r| r.Value()).unwrap_or(false);
            s.TryChangeShuffleActiveAsync(!cur).and_then(|a| a.get())
        }
        Cmd::Repeat => {
            let cur = match s.GetPlaybackInfo().and_then(|i| i.AutoRepeatMode()).and_then(|r| r.Value()) {
                Ok(MediaPlaybackAutoRepeatMode::Track) => Repeat::One,
                Ok(MediaPlaybackAutoRepeatMode::List) => Repeat::All,
                _ => Repeat::Off,
            };
            let next = match cur.next() {
                Repeat::One => MediaPlaybackAutoRepeatMode::Track,
                Repeat::All => MediaPlaybackAutoRepeatMode::List,
                Repeat::Off => MediaPlaybackAutoRepeatMode::None,
            };
            s.TryChangeAutoRepeatModeAsync(next).and_then(|a| a.get())
        }
    };
}
