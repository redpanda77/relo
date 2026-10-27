// The Mac plays a finished clip through AVAudioEngine; here a line's audio is queued into one rodio sink as it is rendered.
// A line starts early only while the engine is clearly faster than it plays (the GPU, or the CPU in a release build); a
// slower engine would run the sink dry mid-line and cut the words off, so then the line waits until it is rendered, as the
// Mac's does. If the sink runs dry anyway it pauses and refills instead of playing on through a hole. One line at a time: starting a line, or `stop`, ends the one before it. The output device is opened for a line and
// released when it has played out (a Bluetooth headset is not held awake between updates).

use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub enum PlayerEvent {
    /// Sound is coming out for line `token`.
    Playing(u64),
    /// Line `token` has played to its end.
    Ended(u64),
    /// The output device could not be used.
    Failed(u64, String),
}

/// Where a line's audio goes. `token` names the line (a newer token supersedes an older one).
pub trait AudioOut: Send + Sync {
    fn start(&self, token: u64);
    fn push(&self, token: u64, samples: &[f32], sample_rate: u32);
    /// No more audio for `token`: `Ended` follows when what was pushed has played.
    fn finish(&self, token: u64);
    fn stop(&self);
}

enum Cmd {
    Start(u64),
    Push(u64, Vec<f32>, u32),
    Finish(u64),
    Stop,
}

/// Seconds of audio buffered before a line starts to sound.
const LEAD_IN_SECS: f64 = 0.2;
/// The engine must produce audio this many times faster than it plays before a line starts ahead of its end: a margin for the
/// PC getting busy, not just for the average.
const SAFE_SPEED: f64 = 2.0;
/// Rate is only trusted after this long of rendering (the first chunk arrives with the model's warm-up).
const RATE_WINDOW: Duration = Duration::from_millis(150);
/// A line that is still rendering after this long starts anyway; a silent card for longer would read as broken.
const MAX_HOLD: Duration = Duration::from_secs(20);
/// After a dry spell, audio to have queued before sound resumes.
const REFILL_SECS: f64 = 0.6;
/// What the output device still holds after the sink reports empty (its last buffer): the line ends after it, so the last
/// word is not clipped when the stream is dropped.
const TAIL: Duration = Duration::from_millis(300);

/// Whether a line whose audio is arriving should start sounding now. Pure, so the policy is tested without a sound card.
/// `buffered` seconds have been pushed, the first push `since_first` ago, and `first_chunk` of it came in that first push.
fn may_start(buffered: f64, first_chunk: f64, since_first: Duration) -> bool {
    if buffered < LEAD_IN_SECS {
        return false;
    }
    if since_first >= MAX_HOLD {
        return true;
    }
    if since_first < RATE_WINDOW {
        return false;
    }
    // Audio produced after the first chunk, per second of waiting for it.
    let speed = (buffered - first_chunk).max(0.0) / since_first.as_secs_f64();
    speed >= SAFE_SPEED
}

pub struct RodioOut {
    tx: Mutex<Sender<Cmd>>,
}

impl RodioOut {
    pub fn new(on_event: std::sync::Arc<dyn Fn(PlayerEvent) + Send + Sync>) -> Self {
        let (tx, rx) = channel::<Cmd>();
        std::thread::Builder::new()
            .name("relo-voice-audio".into())
            .spawn(move || run(rx, on_event))
            .expect("audio thread");
        Self { tx: Mutex::new(tx) }
    }

    fn send(&self, cmd: Cmd) {
        let _ = self.tx.lock().unwrap().send(cmd);
    }
}

impl AudioOut for RodioOut {
    fn start(&self, token: u64) {
        self.send(Cmd::Start(token));
    }
    fn push(&self, token: u64, samples: &[f32], sample_rate: u32) {
        self.send(Cmd::Push(token, samples.to_vec(), sample_rate));
    }
    fn finish(&self, token: u64) {
        self.send(Cmd::Finish(token));
    }
    fn stop(&self) {
        self.send(Cmd::Stop);
    }
}

struct Active {
    token: u64,
    // The stream must outlive the sink; both are dropped together at the end of the line.
    device: Option<(rodio::OutputStream, rodio::Sink)>,
    buffered_secs: f64,
    first_chunk_secs: f64,
    first_push: Option<Instant>,
    /// Audio pushed since the sink last ran dry (the refill target after a hole).
    since_dry_secs: f64,
    started: bool,
    finished: bool,
    /// Set once everything has been handed to the device; the line ends `TAIL` after.
    drained_at: Option<Instant>,
}

fn run(rx: std::sync::mpsc::Receiver<Cmd>, on_event: std::sync::Arc<dyn Fn(PlayerEvent) + Send + Sync>) {
    let mut active: Option<Active> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Cmd::Start(token)) => {
                active = Some(Active {
                    token,
                    device: None,
                    buffered_secs: 0.0,
                    first_chunk_secs: 0.0,
                    first_push: None,
                    since_dry_secs: 0.0,
                    started: false,
                    finished: false,
                    drained_at: None,
                });
            }
            Ok(Cmd::Stop) => active = None,
            Ok(Cmd::Push(token, samples, rate)) => {
                let Some(a) = active.as_mut().filter(|a| a.token == token) else { continue };
                if a.device.is_none() {
                    match open() {
                        Ok(d) => a.device = Some(d),
                        Err(e) => {
                            active = None;
                            on_event(PlayerEvent::Failed(token, e));
                            continue;
                        }
                    }
                }
                if let Some((_, sink)) = &a.device {
                    let secs = samples.len() as f64 / f64::from(rate.max(1));
                    if a.first_push.is_none() {
                        a.first_push = Some(Instant::now());
                        a.first_chunk_secs = secs;
                    }
                    a.buffered_secs += secs;
                    a.since_dry_secs += secs;
                    sink.append(rodio::buffer::SamplesBuffer::new(1, rate, samples));
                    let since_first = a.first_push.map_or(Duration::ZERO, |t| t.elapsed());
                    if !a.started && may_start(a.buffered_secs, a.first_chunk_secs, since_first) {
                        sink.play();
                        a.started = true;
                        on_event(PlayerEvent::Playing(token));
                    } else if a.started && a.drained_at.is_none() && sink.is_paused() && a.since_dry_secs >= REFILL_SECS {
                        // Refilled after a dry spell.
                        sink.play();
                    }
                }
            }
            Ok(Cmd::Finish(token)) => {
                let Some(a) = active.as_mut().filter(|a| a.token == token) else { continue };
                a.finished = true;
                if a.device.is_none() {
                    // Nothing was ever pushed: the line is over.
                    active = None;
                    on_event(PlayerEvent::Ended(token));
                } else if !a.started {
                    if let Some((_, sink)) = &a.device {
                        sink.play();
                    }
                    a.started = true;
                    on_event(PlayerEvent::Playing(token));
                } else if let Some((_, sink)) = &a.device {
                    // The rest arrived while the sink was refilling: play it out.
                    if sink.is_paused() {
                        sink.play();
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if let Some(a) = active.as_mut() {
            if let Some((_, sink)) = &a.device {
                if a.started && sink.empty() {
                    if a.finished {
                        a.drained_at.get_or_insert_with(Instant::now);
                    } else if !sink.is_paused() {
                        // Ran dry before the rest was rendered: wait for a run of audio rather than stutter word by word.
                        sink.pause();
                        a.since_dry_secs = 0.0;
                    }
                }
            }
        }
        let done = active.as_ref().is_some_and(|a| a.drained_at.is_some_and(|t| t.elapsed() >= TAIL));
        if done {
            let token = active.take().map(|a| a.token).unwrap_or_default();
            on_event(PlayerEvent::Ended(token));
        }
    }
}

fn open() -> Result<(rodio::OutputStream, rodio::Sink), String> {
    let mut stream = rodio::OutputStreamBuilder::open_default_stream().map_err(|e| format!("No audio output: {e}"))?;
    stream.log_on_drop(false);
    let sink = rodio::Sink::connect_new(stream.mixer());
    sink.pause();
    Ok((stream, sink))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn a_line_waits_for_a_lead_in_and_for_the_rate_to_be_known() {
        assert!(!may_start(0.1, 0.1, MS(10)));
        // Enough audio, but the speed is not known yet.
        assert!(!may_start(0.5, 0.5, MS(20)));
    }

    #[test]
    fn a_fast_engine_starts_early() {
        // 0.4 s of audio after the first chunk (0.1 s) in 150 ms is 2.7x real time.
        assert!(may_start(0.5, 0.1, MS(150)));
    }

    #[test]
    fn a_slow_engine_waits_for_the_whole_line() {
        // The dev build: 0.33x. Never starts early however long it has been going.
        assert!(!may_start(0.7, 0.3, MS(1200)));
        assert!(!may_start(3.0, 0.3, MS(9000)));
        // An engine barely faster than real time is still too slow to start ahead of.
        assert!(!may_start(2.5, 0.5, MS(1500)));
    }

    #[test]
    fn a_line_that_takes_too_long_starts_anyway() {
        assert!(may_start(5.0, 0.3, MAX_HOLD));
    }
}
