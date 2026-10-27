// Port of apps/notch/ReloVoice/Sources/ReloVoice/SpeechEngine.swift: a clip, an engine that renders one, its errors.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One rendered line: mono samples at `sample_rate`, kept in memory only (a clip is the plaintext of a sealed card).
#[derive(Clone, Debug, PartialEq)]
pub struct SpokenClip {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl SpokenClip {
    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.samples.len() as f64 / f64::from(self.sample_rate)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeechError {
    /// "The Relo voice is not downloaded"
    ModelMissing,
    /// "The voice produced no audio"
    Silent,
    /// The line was cancelled while it was being rendered.
    Cancelled,
    Engine(String),
}

impl fmt::Display for SpeechError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpeechError::ModelMissing => f.write_str("The Relo voice is not downloaded"),
            SpeechError::Silent => f.write_str("The voice produced no audio"),
            SpeechError::Cancelled => f.write_str("Cancelled"),
            SpeechError::Engine(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SpeechError {}

/// A flag a job checks between chunks; setting it abandons the render.
#[derive(Clone, Default, Debug)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A voice that turns a line into a clip. Engines are swappable: the app asks for a clip and plays it, so a different
/// model (or a helper process) replaces one engine without touching the player or the cards.
pub trait SpeechEngine: Send + Sync {
    /// Renders `text`, handing each piece of audio to `on_chunk(samples, sample_rate)` as soon as it exists (so playback
    /// can begin before the line is complete), and returns the whole clip for the cache.
    fn render_stream(
        &self,
        text: &str,
        cancel: &Cancel,
        on_chunk: &mut dyn FnMut(&[f32], u32),
    ) -> Result<SpokenClip, SpeechError>;

    /// Renders `text` as one clip (the Mac's `render`).
    fn render(&self, text: &str, cancel: &Cancel) -> Result<SpokenClip, SpeechError> {
        self.render_stream(text, cancel, &mut |_, _| {})
    }

    /// Frees what the engine holds (a model); the next render loads again.
    fn unload(&self);
}
