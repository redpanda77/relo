// Port of ReloVoice.swift: what the app talks to. Speak a card's line, stop, and which line is playing. One line at a time; a
// clip is rendered once per line and kept in memory for replay (never on disk), the oldest dropped past 16.
//
// Engine choice (the Mac's `clip(id:text:)`): the Relo voice (Phonon) once its files are in place, the system voice until then
// and whenever Phonon fails to load or render. A line already rendered is replayed from the cache.

use super::engine::{Cancel, SpeechEngine, SpeechError, SpokenClip};
use super::phonon::PhononEngine;
use super::player::{AudioOut, PlayerEvent};
use super::store::VoiceModelStore;
use serde::Serialize;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const CACHE_SIZE: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// Phonon once downloaded; the system voice until then.
    Relo,
    System,
}

impl Engine {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "relo" => Some(Engine::Relo),
            "system" => Some(Engine::System),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Relo => "relo",
            Engine::System => "system",
        }
    }
}

/// Which voice says a line: Phonon only when it was asked for and its files are in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Phonon,
    System,
}

pub fn choose(engine: Engine, model_ready: bool) -> Which {
    if engine == Engine::Relo && model_ready {
        Which::Phonon
    } else {
        Which::System
    }
}

/// The Mac's `phase`: nothing, a line being prepared, a line playing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Preparing(String),
    Playing(String),
}

/// What the page sees (event `voice_state`, command `voice_status`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    /// "idle", "preparing" or "playing".
    pub phase: &'static str,
    /// The line (`voice_speak`'s lineId) when not idle.
    pub id: Option<String>,
    pub engine: &'static str,
    pub error: Option<String>,
}

/// 16 clips, the oldest dropped first (the Mac's `remember`).
#[derive(Default)]
pub struct ClipCache {
    clips: HashMap<String, SpokenClip>,
    order: Vec<String>,
}

impl ClipCache {
    pub fn get(&self, id: &str) -> Option<SpokenClip> {
        self.clips.get(id).cloned()
    }
    pub fn remember(&mut self, id: &str, clip: SpokenClip) {
        self.clips.insert(id.to_string(), clip);
        self.order.retain(|o| o != id);
        self.order.push(id.to_string());
        while self.order.len() > CACHE_SIZE {
            let oldest = self.order.remove(0);
            self.clips.remove(&oldest);
        }
    }
    pub fn clear(&mut self) {
        self.clips.clear();
        self.order.clear();
    }
    pub fn len(&self) -> usize {
        self.clips.len()
    }
}

struct State {
    engine: Engine,
    phase: Phase,
    last_error: Option<String>,
    clips: ClipCache,
    cancel: Cancel,
}

struct Inner {
    store: VoiceModelStore,
    phonon: Arc<dyn SpeechEngine>,
    system: Arc<dyn SpeechEngine>,
    out: Arc<dyn AudioOut>,
    state: Mutex<State>,
    /// The current line's token: anything older is stale.
    line: AtomicU64,
    previews: AtomicU64,
    notify: Arc<dyn Fn(VoiceState) + Send + Sync>,
}

#[derive(Clone)]
pub struct Voice {
    inner: Arc<Inner>,
}

impl Voice {
    pub fn new(
        store: VoiceModelStore,
        phonon: Arc<dyn SpeechEngine>,
        system: Arc<dyn SpeechEngine>,
        out: Arc<dyn AudioOut>,
        notify: Arc<dyn Fn(VoiceState) + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                phonon,
                system,
                out,
                state: Mutex::new(State {
                    engine: Engine::Relo,
                    phase: Phase::Idle,
                    last_error: None,
                    clips: ClipCache::default(),
                    cancel: Cancel::new(),
                }),
                line: AtomicU64::new(0),
                previews: AtomicU64::new(0),
                notify,
            }),
        }
    }

    pub fn store(&self) -> &VoiceModelStore {
        &self.inner.store
    }

    pub fn state(&self) -> VoiceState {
        Self::snapshot(&self.inner.state.lock().unwrap())
    }

    fn snapshot(s: &State) -> VoiceState {
        let (phase, id) = match &s.phase {
            Phase::Idle => ("idle", None),
            Phase::Preparing(id) => ("preparing", Some(id.clone())),
            Phase::Playing(id) => ("playing", Some(id.clone())),
        };
        VoiceState { phase, id, engine: s.engine.as_str(), error: s.last_error.clone() }
    }

    pub fn engine(&self) -> Engine {
        self.inner.state.lock().unwrap().engine
    }

    pub fn set_engine(&self, engine: Engine) {
        let snap = {
            let mut s = self.inner.state.lock().unwrap();
            if s.engine == engine {
                return;
            }
            s.engine = engine;
            Self::snapshot(&s)
        };
        (self.inner.notify)(snap);
    }

    /// At launch: fetch the Relo voice when it is missing (on an unmetered connection), else warm it once.
    pub fn start(&self) {
        if self.inner.store.is_ready() {
            self.prewarm();
        } else {
            self.inner.store.download_when_unmetered();
        }
    }

    /// After an install or an update, the first render sets the model up: do it once in the background so it never lands on a
    /// real line. The idle timeout frees the model after.
    pub fn prewarm(&self) {
        if self.engine() != Engine::Relo || !self.inner.store.is_ready() {
            return;
        }
        let phonon = self.inner.phonon.clone();
        std::thread::Builder::new()
            .name("relo-voice-prewarm".into())
            .spawn(move || {
                let _ = phonon.render("Ready.", &Cancel::new());
            })
            .ok();
    }

    /// Is this line the one preparing or playing?
    pub fn is_active(&self, id: &str) -> bool {
        match &self.inner.state.lock().unwrap().phase {
            Phase::Idle => false,
            Phase::Preparing(c) | Phase::Playing(c) => c == id,
        }
    }

    pub fn is_busy(&self) -> bool {
        self.inner.state.lock().unwrap().phase != Phase::Idle
    }

    pub fn toggle(&self, id: &str, text: &str) {
        if self.is_active(id) {
            self.stop();
        } else {
            self.speak(id, text);
        }
    }

    /// `id` names the line (a card and what it says), so a changed card renders again.
    pub fn speak(&self, id: &str, text: &str) {
        let (token, cancel, snap) = {
            let mut s = self.inner.state.lock().unwrap();
            s.cancel.cancel();
            let token = self.inner.line.fetch_add(1, Ordering::SeqCst) + 1;
            s.cancel = Cancel::new();
            s.last_error = None;
            s.phase = Phase::Preparing(id.to_string());
            (token, s.cancel.clone(), Self::snapshot(&s))
        };
        self.inner.out.stop();
        self.inner.out.start(token);
        (self.inner.notify)(snap);
        let this = self.clone();
        let (id, text) = (id.to_string(), text.to_string());
        std::thread::Builder::new()
            .name("relo-voice-line".into())
            .spawn(move || this.run_line(token, &id, &text, &cancel))
            .ok();
    }

    pub fn stop(&self) {
        let snap = {
            let mut s = self.inner.state.lock().unwrap();
            s.cancel.cancel();
            self.inner.line.fetch_add(1, Ordering::SeqCst);
            let changed = s.phase != Phase::Idle;
            s.phase = Phase::Idle;
            changed.then(|| Self::snapshot(&s))
        };
        self.inner.out.stop();
        if let Some(snap) = snap {
            (self.inner.notify)(snap);
        }
    }

    /// Deletes the Relo voice's files and frees the model if it is loaded.
    pub fn delete_model(&self) {
        self.stop();
        self.inner.state.lock().unwrap().clips.clear();
        self.inner.phonon.unload();
        self.inner.store.delete();
    }

    /// Settings' preview: always rendered fresh, never cached.
    pub fn preview(&self) {
        let n = self.inner.previews.fetch_add(1, Ordering::SeqCst);
        self.speak(&format!("preview-{n}"), "This is the Relo voice. Your deploy finished.");
    }

    fn current(&self, token: u64) -> bool {
        self.inner.line.load(Ordering::SeqCst) == token
    }

    fn run_line(&self, token: u64, id: &str, text: &str, cancel: &Cancel) {
        let outcome = self.render_and_queue(token, id, text, cancel);
        match outcome {
            Ok(()) => {
                if self.current(token) {
                    self.inner.out.finish(token);
                }
            }
            Err(SpeechError::Cancelled) => {}
            Err(e) => {
                if !self.current(token) {
                    return;
                }
                let snap = {
                    let mut s = self.inner.state.lock().unwrap();
                    s.last_error = Some(e.to_string());
                    if matches!(&s.phase, Phase::Preparing(c) | Phase::Playing(c) if c == id) {
                        s.phase = Phase::Idle;
                    }
                    Self::snapshot(&s)
                };
                self.inner.out.stop();
                (self.inner.notify)(snap);
            }
        }
    }

    /// The Mac's `clip(id:text:)`, streaming: cached line, else Phonon when ready (the system voice if Phonon fails), else
    /// the system voice. Audio goes to the player as it is rendered.
    fn render_and_queue(&self, token: u64, id: &str, text: &str, cancel: &Cancel) -> Result<(), SpeechError> {
        let (cached, engine) = {
            let s = self.inner.state.lock().unwrap();
            (s.clips.get(id), s.engine)
        };
        if let Some(clip) = cached {
            if self.current(token) {
                self.inner.out.push(token, &clip.samples, clip.sample_rate);
            }
            return Ok(());
        }
        let pushed = Cell::new(false);
        let mut push = |samples: &[f32], rate: u32| {
            if self.current(token) {
                self.inner.out.push(token, samples, rate);
                pushed.set(true);
            }
        };
        let clip = match choose(engine, self.inner.store.is_ready()) {
            Which::Phonon => match self.inner.phonon.render_stream(text, cancel, &mut push) {
                Ok(c) => c,
                Err(SpeechError::Cancelled) => return Err(SpeechError::Cancelled),
                // The Relo voice failed to load or render: the line is still said.
                Err(_) if !pushed.get() => self.inner.system.render_stream(text, cancel, &mut push)?,
                Err(e) => return Err(e),
            },
            Which::System => self.inner.system.render_stream(text, cancel, &mut push)?,
        };
        if !id.starts_with("preview-") {
            self.inner.state.lock().unwrap().clips.remember(id, clip);
        }
        Ok(())
    }

    /// From the player: sound started, the line ended, or the device failed.
    pub fn on_player_event(&self, event: PlayerEvent) {
        let snap = {
            let mut s = self.inner.state.lock().unwrap();
            match event {
                PlayerEvent::Playing(t) if self.current(t) => match s.phase.clone() {
                    Phase::Preparing(id) => {
                        s.phase = Phase::Playing(id);
                        Some(Self::snapshot(&s))
                    }
                    _ => None,
                },
                PlayerEvent::Ended(t) if self.current(t) && s.phase != Phase::Idle => {
                    s.phase = Phase::Idle;
                    Some(Self::snapshot(&s))
                }
                PlayerEvent::Failed(t, message) if self.current(t) => {
                    s.cancel.cancel();
                    s.last_error = Some(message);
                    s.phase = Phase::Idle;
                    Some(Self::snapshot(&s))
                }
                _ => None,
            }
        };
        if let Some(snap) = snap {
            (self.inner.notify)(snap);
        }
    }
}

/// Builds the app's voice: Phonon over the store's folder, the system voice, and the rodio player.
pub fn build(store: VoiceModelStore, notify: Arc<dyn Fn(VoiceState) + Send + Sync>) -> (Voice, Arc<PhononEngine>) {
    use std::sync::OnceLock;
    let slot: Arc<OnceLock<Voice>> = Arc::default();
    let to_voice = slot.clone();
    let out = Arc::new(super::player::RodioOut::new(Arc::new(move |event| {
        if let Some(v) = to_voice.get() {
            v.on_player_event(event);
        }
    })));
    let phonon = Arc::new(PhononEngine::new(store.directory()));
    let voice = Voice::new(store, phonon.clone(), Arc::new(super::system::SystemSpeechEngine::new()), out, notify);
    let _ = slot.set(voice.clone());
    let warm = voice.clone();
    voice.store().set_on_ready(Arc::new(move || warm.prewarm()));
    (voice, phonon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::network::{Network, NetworkProbe};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::time::{Duration, Instant};

    #[derive(Debug, PartialEq, Clone)]
    enum Call {
        Start(u64),
        Push(u64, usize),
        Finish(u64),
        Stop,
    }

    #[derive(Default)]
    struct FakeOut(Mutex<Vec<Call>>);
    impl AudioOut for FakeOut {
        fn start(&self, t: u64) {
            self.0.lock().unwrap().push(Call::Start(t));
        }
        fn push(&self, t: u64, s: &[f32], _r: u32) {
            self.0.lock().unwrap().push(Call::Push(t, s.len()));
        }
        fn finish(&self, t: u64) {
            self.0.lock().unwrap().push(Call::Finish(t));
        }
        fn stop(&self) {
            self.0.lock().unwrap().push(Call::Stop);
        }
    }

    struct FakeEngine {
        name: &'static str,
        renders: AtomicUsize,
        fail: AtomicBool,
        /// Block inside the render until cancelled (a slow line).
        slow: AtomicBool,
    }
    impl FakeEngine {
        fn new(name: &'static str) -> Arc<Self> {
            Arc::new(Self { name, renders: AtomicUsize::new(0), fail: AtomicBool::new(false), slow: AtomicBool::new(false) })
        }
    }
    impl SpeechEngine for FakeEngine {
        fn render_stream(
            &self,
            text: &str,
            cancel: &Cancel,
            on_chunk: &mut dyn FnMut(&[f32], u32),
        ) -> Result<SpokenClip, SpeechError> {
            self.renders.fetch_add(1, Ordering::SeqCst);
            if self.slow.load(Ordering::SeqCst) {
                let until = Instant::now() + Duration::from_secs(5);
                while !cancel.is_cancelled() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(5));
                }
                return Err(SpeechError::Cancelled);
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(SpeechError::Engine(format!("{} failed", self.name)));
            }
            // The sample count carries the engine and the text length: tests tell who spoke.
            let n = text.len() * if self.name == "phonon" { 100 } else { 10 };
            let samples = vec![0.1; n];
            on_chunk(&samples, 24_000);
            Ok(SpokenClip { samples, sample_rate: 24_000 })
        }
        fn unload(&self) {}
    }

    struct Online;
    impl NetworkProbe for Online {
        fn status(&self) -> Network {
            Network::Unmetered
        }
    }

    struct Rig {
        voice: Voice,
        phonon: Arc<FakeEngine>,
        system: Arc<FakeEngine>,
        out: Arc<FakeOut>,
        states: Arc<Mutex<Vec<VoiceState>>>,
    }

    fn rig(model_ready: bool) -> Rig {
        let root = std::env::temp_dir().join(format!("relo-voice-svc-{}-{}", std::process::id(), model_ready));
        let _ = std::fs::remove_dir_all(&root);
        let mut model = crate::voice::store::VoiceModel::phonon_31m_en();
        model.files.clear();
        if !model_ready {
            // One file nobody has: the store is not ready.
            model.files.push(crate::voice::store::ModelFile { name: "missing.bin".into(), bytes: 3, sha256: "0".repeat(64) });
        }
        let store = VoiceModelStore::new(model, root, Arc::new(Online), Arc::new(|_| {}));
        assert_eq!(store.is_ready(), model_ready);
        let (phonon, system, out) = (FakeEngine::new("phonon"), FakeEngine::new("system"), Arc::new(FakeOut::default()));
        let states: Arc<Mutex<Vec<VoiceState>>> = Arc::default();
        let sink = states.clone();
        let voice = Voice::new(store, phonon.clone(), system.clone(), out.clone(), Arc::new(move |s| sink.lock().unwrap().push(s)));
        Rig { voice, phonon, system, out, states }
    }

    fn until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..400 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for {what}");
    }

    fn finished(r: &Rig, token: u64) -> bool {
        r.out.0.lock().unwrap().contains(&Call::Finish(token))
    }

    #[test]
    fn the_relo_voice_is_chosen_only_when_asked_for_and_downloaded() {
        assert_eq!(choose(Engine::Relo, true), Which::Phonon);
        assert_eq!(choose(Engine::Relo, false), Which::System);
        assert_eq!(choose(Engine::System, true), Which::System);
        assert_eq!(choose(Engine::System, false), Which::System);
    }

    #[test]
    fn a_downloaded_model_speaks_with_phonon() {
        let r = rig(true);
        r.voice.speak("a", "Hello.");
        until("finish", || finished(&r, 1));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 1);
        assert_eq!(r.system.renders.load(Ordering::SeqCst), 0);
        assert!(r.out.0.lock().unwrap().contains(&Call::Push(1, 600)));
    }

    #[test]
    fn without_the_model_the_system_voice_says_the_line() {
        let r = rig(false);
        r.voice.speak("a", "Hello.");
        until("finish", || finished(&r, 1));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 0);
        assert!(r.out.0.lock().unwrap().contains(&Call::Push(1, 60)));
    }

    #[test]
    fn a_failing_relo_voice_falls_back_to_the_system_voice() {
        let r = rig(true);
        r.phonon.fail.store(true, Ordering::SeqCst);
        r.voice.speak("a", "Hello.");
        until("finish", || finished(&r, 1));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 1);
        assert_eq!(r.system.renders.load(Ordering::SeqCst), 1);
        assert_eq!(r.voice.state().error, None, "the line was still said");
    }

    #[test]
    fn the_system_engine_setting_skips_phonon() {
        let r = rig(true);
        r.voice.set_engine(Engine::System);
        r.voice.speak("a", "Hello.");
        until("finish", || finished(&r, 1));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn both_voices_failing_reports_the_error_and_goes_idle() {
        let r = rig(true);
        r.phonon.fail.store(true, Ordering::SeqCst);
        r.system.fail.store(true, Ordering::SeqCst);
        r.voice.speak("a", "Hello.");
        until("error", || r.voice.state().error.is_some());
        assert_eq!(r.voice.state().phase, "idle");
        assert_eq!(r.voice.state().error.as_deref(), Some("system failed"));
    }

    #[test]
    fn a_line_is_rendered_once_and_replayed_from_memory() {
        let r = rig(true);
        r.voice.speak("card|Done.", "Done.");
        until("first", || finished(&r, 1));
        until("remembered", || r.voice.inner.state.lock().unwrap().clips.len() == 1);
        r.voice.speak("card|Done.", "Done.");
        until("second", || finished(&r, 2));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 1);
        assert!(r.out.0.lock().unwrap().contains(&Call::Push(2, 500)));
    }

    #[test]
    fn a_preview_is_never_remembered() {
        let r = rig(true);
        r.voice.preview();
        until("first", || finished(&r, 1));
        r.voice.preview();
        until("second", || finished(&r, 2));
        assert_eq!(r.phonon.renders.load(Ordering::SeqCst), 2);
        assert_eq!(r.voice.inner.state.lock().unwrap().clips.len(), 0);
    }

    #[test]
    fn the_cache_keeps_sixteen_lines_and_drops_the_oldest() {
        let mut cache = ClipCache::default();
        let clip = SpokenClip { samples: vec![0.0; 4], sample_rate: 24_000 };
        for i in 0..20 {
            cache.remember(&format!("line-{i}"), clip.clone());
        }
        assert_eq!(cache.len(), CACHE_SIZE);
        assert!(cache.get("line-3").is_none());
        assert!(cache.get("line-4").is_some());
        // Remembering a line again makes it the newest.
        cache.remember("line-4", clip.clone());
        cache.remember("line-20", clip);
        assert!(cache.get("line-4").is_some());
        assert!(cache.get("line-5").is_none());
    }

    #[test]
    fn stopping_cancels_the_render_and_says_nothing_more() {
        let r = rig(true);
        r.phonon.slow.store(true, Ordering::SeqCst);
        r.voice.speak("slow", "A long line.");
        until("preparing", || r.voice.state().phase == "preparing");
        r.voice.stop();
        assert_eq!(r.voice.state().phase, "idle");
        std::thread::sleep(Duration::from_millis(60));
        assert!(!finished(&r, 1), "a cancelled line is never finished");
        assert!(r.out.0.lock().unwrap().iter().filter(|c| **c == Call::Stop).count() >= 1);
    }

    #[test]
    fn a_new_line_replaces_the_one_before_and_a_toggle_stops_the_active_one() {
        let r = rig(true);
        r.phonon.slow.store(true, Ordering::SeqCst);
        r.voice.speak("one", "First.");
        r.voice.speak("two", "Second.");
        assert!(r.voice.is_active("two") && !r.voice.is_active("one"));
        r.voice.toggle("two", "Second.");
        assert!(!r.voice.is_busy());
        r.voice.toggle("two", "Second.");
        assert!(r.voice.is_active("two"));
        r.voice.stop();
    }

    #[test]
    fn player_events_move_the_phase_and_stale_ones_are_ignored() {
        let r = rig(true);
        r.voice.speak("a", "Hello.");
        until("finish", || finished(&r, 1));
        r.voice.on_player_event(PlayerEvent::Playing(99));
        assert_eq!(r.voice.state().phase, "preparing");
        r.voice.on_player_event(PlayerEvent::Playing(1));
        assert_eq!(r.voice.state().phase, "playing");
        r.voice.on_player_event(PlayerEvent::Ended(1));
        assert_eq!(r.voice.state().phase, "idle");
        let phases: Vec<&str> = r.states.lock().unwrap().iter().map(|s| s.phase).collect();
        assert_eq!(phases, ["preparing", "playing", "idle"]);
    }

    #[test]
    fn a_device_failure_is_reported() {
        let r = rig(true);
        r.voice.speak("a", "Hello.");
        r.voice.on_player_event(PlayerEvent::Failed(1, "No audio output".into()));
        assert_eq!(r.voice.state().phase, "idle");
        assert_eq!(r.voice.state().error.as_deref(), Some("No audio output"));
    }
}
