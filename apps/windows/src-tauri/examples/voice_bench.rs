// Times one Phonon line outside the app: model load, first audio, total render, real-time factor, and the CPU the process
// used while rendering (kernel + user time over wall time, in cores). Run it in release for the numbers the owner gets:
//   cargo run --release --example voice_bench -- <model dir> ["text"] [runs]
// RELO_VOICE_DEVICE=cpu|vulkan picks the device (see phonon.rs); RELO_VOICE_THREADS caps the CPU threads.
// The app's own modules are included by path (the crate is a binary, so an example cannot link it).

#[allow(dead_code)]
mod voice {
    #[path = "../../src/voice/engine.rs"]
    pub mod engine;
    #[path = "../../src/voice/phonon.rs"]
    pub mod phonon;
}

use std::time::Instant;
use voice::engine::{Cancel, SpeechEngine};
use voice::phonon::PhononEngine;

fn cpu_secs() -> f64 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u).unwrap() };
    let t = |f: FILETIME| ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 1e7;
    t(k) + t(u)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("model directory");
    let text = args.next().unwrap_or_else(|| {
        "Your build finished and all forty-two tests passed. I pushed the branch, so it is ready for you to look at.".into()
    });
    let runs: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(3);
    let engine = PhononEngine::new(dir.into());
    for run in 0..runs {
        let (cpu0, wall0) = (cpu_secs(), Instant::now());
        let mut gaps = 0u32;
        let mut played = 0.0f64; // seconds of audio handed over so far
        let mut late = 0.0f64; // worst moment the audio so far was shorter than the wall clock after the first chunk
        let mut first_at = None::<f64>;
        let clip = engine
            .render_stream(&text, &Cancel::new(), &mut |s, rate| {
                let now = wall0.elapsed().as_secs_f64();
                let start = *first_at.get_or_insert(now);
                // Playback of the first chunk starts at `start`; an underrun is a chunk arriving after everything before it ended.
                let behind = now - (start + played);
                if played > 0.0 && behind > 0.0 {
                    gaps += 1;
                    late = late.max(behind);
                }
                played += s.len() as f64 / f64::from(rate);
            })
            .expect("render");
        let wall = wall0.elapsed().as_secs_f64();
        let cpu = cpu_secs() - cpu0;
        let st = engine.last_stats().unwrap();
        println!(
            "run {run}: load {} ms, first audio {} ms, render {} ms for {:.2} s of audio (RTF {:.2}x), cpu {:.2} s over {:.2} s wall = {:.1} cores, underruns if played live from first chunk: {gaps} (worst {:.0} ms)",
            st.load_ms, st.first_audio_ms, st.total_ms, clip.duration_secs(),
            clip.duration_secs() / (st.total_ms as f64 / 1000.0), cpu, wall, cpu / wall, late * 1000.0
        );
    }
    println!("device: {}", engine.device_label());
}
