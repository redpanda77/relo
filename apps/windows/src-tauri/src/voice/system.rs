// Port of SystemSpeechEngine.swift: the PC's own voice (Windows.Media.SpeechSynthesis). Nothing to download, so the play
// button works before the Relo voice is in place, and when it fails to load. WinRT hands back a WAV stream; it is decoded to
// mono PCM like every other clip.

use super::engine::{Cancel, SpeechEngine, SpeechError, SpokenClip};

#[derive(Default)]
pub struct SystemSpeechEngine;

impl SystemSpeechEngine {
    pub fn new() -> Self {
        Self
    }
}

impl SpeechEngine for SystemSpeechEngine {
    fn render_stream(
        &self,
        text: &str,
        cancel: &Cancel,
        on_chunk: &mut dyn FnMut(&[f32], u32),
    ) -> Result<SpokenClip, SpeechError> {
        if cancel.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        let wav = synthesize_wav(text)?;
        if cancel.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        let clip = super::wav::decode_wav(&wav)?;
        on_chunk(&clip.samples, clip.sample_rate);
        Ok(clip)
    }

    fn unload(&self) {}
}

#[cfg(windows)]
fn synthesize_wav(text: &str) -> Result<Vec<u8>, SpeechError> {
    use windows::core::HSTRING;
    use windows::Media::SpeechSynthesis::SpeechSynthesizer;
    use windows::Storage::Streams::DataReader;

    let fail = |e: windows::core::Error| SpeechError::Engine(format!("The system voice failed: {e}"));
    super::com_init();
    let synthesizer = SpeechSynthesizer::new().map_err(fail)?;
    // en-US, as the Mac asks for; the system default when no such voice is installed.
    if let Ok(voices) = SpeechSynthesizer::AllVoices() {
        for voice in voices {
            if voice.Language().map(|l| l.to_string().eq_ignore_ascii_case("en-US")).unwrap_or(false) {
                let _ = synthesizer.SetVoice(&voice);
                break;
            }
        }
    }
    let stream = synthesizer.SynthesizeTextToStreamAsync(&HSTRING::from(text)).map_err(fail)?.get().map_err(fail)?;
    let size = stream.Size().map_err(fail)? as u32;
    if size == 0 {
        return Err(SpeechError::Silent);
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(fail)?).map_err(fail)?;
    reader.LoadAsync(size).map_err(fail)?.get().map_err(fail)?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).map_err(fail)?;
    Ok(bytes)
}

#[cfg(not(windows))]
fn synthesize_wav(_text: &str) -> Result<Vec<u8>, SpeechError> {
    Err(SpeechError::Engine("The system voice is only available on Windows".into()))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Needs a speech voice installed (every Windows 11 has one): proves the WinRT call and the WAV decode end to end.
    #[test]
    fn the_system_voice_renders_a_clip() {
        let clip = SystemSpeechEngine::new().render("Hello from the system voice.", &Cancel::new()).unwrap();
        assert!(clip.sample_rate >= 8_000);
        assert!(clip.duration_secs() > 0.5, "{}", clip.duration_secs());
        assert!(clip.samples.iter().any(|s| s.abs() > 0.01));
    }
}
