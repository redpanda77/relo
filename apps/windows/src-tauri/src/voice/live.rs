// Against the real model and the real speakers: `cargo test --release live -- --ignored --nocapture`. Downloads the pinned
// files into %LOCALAPPDATA%\Relo\voice through the store (SHA-256 checked) if they are not there, then speaks three lines and
// prints timings.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[test]
#[ignore = "downloads ~100 MB and plays sound"]
fn download_and_speak_three_lines() {
    let store = VoiceModelStore::new(
        VoiceModel::phonon_31m_en(),
        VoiceModelStore::default_root(),
        Arc::new(network::SystemNetwork),
        Arc::new(|s| eprintln!("model: {:?} {:.0}%", s.state, s.fraction * 100.0)),
    );
    let t = Instant::now();
    if !store.is_ready() {
        store.download();
        while store.status().state == store::StateKind::Downloading {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    let status = store.status();
    eprintln!("download/verify: {:?} in {:?} -> {}", status.state, t.elapsed(), status.directory);
    assert_eq!(status.state, store::StateKind::Ready, "{:?}", status.error);

    let playing = Arc::new(AtomicBool::new(false));
    let flag = playing.clone();
    let (voice, phonon) = service::build(
        store,
        Arc::new(move |s| {
            eprintln!("state: {} {:?}", s.phase, s.id);
            flag.store(s.phase != "idle", Ordering::SeqCst);
        }),
    );
    let lines = [
        "Needs you: Notch redesign. Allow Bash?",
        "Finished: Release gates. All gates passed and the build is ready for your review.",
        "Your turn: Speaking support. Relo for Windows now reads cards aloud in the same voice as the Mac, with no server involved.",
    ];
    let say = |id: &str, text: &str| {
        voice.speak(id, text);
        std::thread::sleep(Duration::from_millis(100));
        while playing.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    for (i, line) in lines.iter().enumerate() {
        let t = Instant::now();
        say(&format!("live-{i}"), line);
        eprintln!("line {i} ({} chars): wall {:?}, render {:?}", line.len(), t.elapsed(), phonon.last_stats());
    }
    // The first line again: replayed from memory, not rendered.
    let before = phonon.last_stats().map(|s| s.total_ms);
    say("live-0", lines[0]);
    assert_eq!(phonon.last_stats().map(|s| s.total_ms), before);
    // The system voice, for comparison.
    voice.set_engine(Engine::System);
    say("live-system", lines[0]);
    assert_eq!(voice.state().error, None);
}
