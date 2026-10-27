//! Quitting plays its sound first (boringNotchApp.swift: `applicationShouldTerminate` waits `min(duration, 2 s)` when sounds
//! and interface sounds are on). The page owns the sounds, so quitting is a round trip:
//!
//!   Rust `request` -> event `quit_request` to the notch page -> the page plays the cue (`alerts.quitSound()`) and answers
//!   `quit_ready(ms)` with how long the sound lasts (0 = none) -> Rust waits that long (at most 2 s) -> exit.
//!
//! If the page never answers (hidden, crashed, not loaded) Rust exits after `ANSWER_WAIT`. A second quit request while one is
//! pending exits at once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The longest the sound may delay the exit.
pub const MAX_DELAY_MS: u64 = 2000;
/// How long Rust waits for the page's answer before it exits without a sound.
pub const ANSWER_WAIT: Duration = Duration::from_millis(750);

static QUITTING: AtomicBool = AtomicBool::new(false);
static ANSWER: Mutex<Option<Sender<u64>>> = Mutex::new(None);

/// How long to wait before exiting, given the page's answer (None = it did not answer).
pub fn delay_for(answer_ms: Option<u64>) -> Duration {
    Duration::from_millis(answer_ms.unwrap_or(0).min(MAX_DELAY_MS))
}

/// Waits for the page's answer for at most `wait`, and returns the delay the exit should honor.
pub fn delay_after_waiting(answers: &Receiver<u64>, wait: Duration) -> Duration {
    match answers.recv_timeout(wait) {
        Ok(ms) => delay_for(Some(ms)),
        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => delay_for(None),
    }
}

/// Starts a quit: the tray's Quit and the Settings window's Quit both come here.
pub fn request(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    let (tx, rx) = mpsc::channel();
    *ANSWER.lock().unwrap() = Some(tx);
    if app.emit_to("notch", "quit_request", ()).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let delay = delay_after_waiting(&rx, ANSWER_WAIT);
        std::thread::sleep(delay);
        app.exit(0);
    });
}

/// The page's answer: the milliseconds its quit sound lasts (0 = no sound).
#[tauri::command]
pub fn quit_ready(ms: f64) {
    let ms = if ms.is_finite() && ms > 0.0 { ms as u64 } else { 0 };
    if let Some(tx) = ANSWER.lock().unwrap().take() {
        let _ = tx.send(ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delay_is_the_sound_and_never_more_than_two_seconds() {
        assert_eq!(delay_for(None), Duration::ZERO);
        assert_eq!(delay_for(Some(0)), Duration::ZERO);
        assert_eq!(delay_for(Some(640)), Duration::from_millis(640));
        assert_eq!(delay_for(Some(2000)), Duration::from_millis(2000));
        assert_eq!(delay_for(Some(9000)), Duration::from_millis(2000));
    }

    #[test]
    fn a_page_that_answers_sets_the_delay() {
        let (tx, rx) = mpsc::channel();
        tx.send(450).unwrap();
        assert_eq!(delay_after_waiting(&rx, Duration::from_millis(500)), Duration::from_millis(450));
    }

    #[test]
    fn a_page_that_never_answers_does_not_hold_the_exit() {
        let (_tx, rx) = mpsc::channel::<u64>();
        assert_eq!(delay_after_waiting(&rx, Duration::from_millis(20)), Duration::ZERO);
    }

    #[test]
    fn a_page_that_is_gone_does_not_hold_the_exit() {
        let (tx, rx) = mpsc::channel::<u64>();
        drop(tx);
        assert_eq!(delay_after_waiting(&rx, Duration::from_millis(500)), Duration::ZERO);
    }

    #[test]
    fn the_answer_is_sanitized() {
        let (tx, rx) = mpsc::channel();
        *ANSWER.lock().unwrap() = Some(tx);
        quit_ready(f64::NAN);
        assert_eq!(rx.recv().unwrap(), 0);
        let (tx, rx) = mpsc::channel();
        *ANSWER.lock().unwrap() = Some(tx);
        quit_ready(1234.7);
        assert_eq!(rx.recv().unwrap(), 1234);
    }
}
