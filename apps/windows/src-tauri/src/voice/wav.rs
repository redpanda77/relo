// RIFF/WAVE to mono f32 PCM: what the system voice's stream is decoded with. Integer PCM (8, 16, 24, 32 bit), IEEE float,
// and WAVE_FORMAT_EXTENSIBLE wrapping either; several channels are averaged to one.

use super::engine::{SpeechError, SpokenClip};

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32le(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

pub fn decode_wav(bytes: &[u8]) -> Result<SpokenClip, SpeechError> {
    let bad = |m: &str| SpeechError::Engine(format!("Could not read the system voice's audio: {m}"));
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("not a WAV stream"));
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None; // tag, channels, rate, bits
    let mut data: Option<&[u8]> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32le(bytes, at + 4).unwrap_or(0) as usize;
        let body = at + 8;
        // A streamed WAV may declare a size larger than what arrived (or 0xFFFFFFFF): take what is there.
        let end = body.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " => {
                let tag = u16le(bytes, body).ok_or_else(|| bad("short fmt"))?;
                let channels = u16le(bytes, body + 2).ok_or_else(|| bad("short fmt"))?;
                let rate = u32le(bytes, body + 4).ok_or_else(|| bad("short fmt"))?;
                let bits = u16le(bytes, body + 14).ok_or_else(|| bad("short fmt"))?;
                // WAVE_FORMAT_EXTENSIBLE: the real tag is the first two bytes of the sub-format GUID.
                let tag = if tag == 0xFFFE { u16le(bytes, body + 24).unwrap_or(tag) } else { tag };
                format = Some((tag, channels, rate, bits));
            }
            b"data" => {
                data = Some(&bytes[body..end]);
                break;
            }
            _ => {}
        }
        at = end + (size & 1);
    }
    let (tag, channels, rate, bits) = format.ok_or_else(|| bad("no fmt chunk"))?;
    let data = data.ok_or_else(|| bad("no data chunk"))?;
    if channels == 0 || rate == 0 {
        return Err(bad("empty format"));
    }
    let width = usize::from(bits / 8);
    let channels = usize::from(channels);
    let frame = width * channels;
    if frame == 0 {
        return Err(bad("empty format"));
    }
    let read = |s: &[u8]| -> Option<f32> {
        match (tag, bits) {
            (1, 8) => Some((f32::from(s[0]) - 128.0) / 128.0),
            (1, 16) => Some(f32::from(i16::from_le_bytes([s[0], s[1]])) / 32_768.0),
            (1, 24) => Some((i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0),
            (1, 32) => Some(i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0),
            (3, 32) => Some(f32::from_le_bytes([s[0], s[1], s[2], s[3]])),
            (3, 64) => {
                Some(f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]) as f32)
            }
            _ => None,
        }
    };
    let mut samples = Vec::with_capacity(data.len() / frame);
    for f in data.chunks_exact(frame) {
        let mut sum = 0.0;
        for c in 0..channels {
            sum += read(&f[c * width..(c + 1) * width]).ok_or_else(|| bad("unsupported sample format"))?;
        }
        samples.push(sum / channels as f32);
    }
    if samples.is_empty() {
        return Err(SpeechError::Silent);
    }
    Ok(SpokenClip { samples, sample_rate: rate })
}

#[cfg(test)]
pub(crate) fn encode_pcm16(samples: &[i16], rate: u32, channels: u16) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_mono_pcm16() {
        let clip = decode_wav(&encode_pcm16(&[0, 16_384, -16_384, 32_767], 22_050, 1)).unwrap();
        assert_eq!(clip.sample_rate, 22_050);
        assert_eq!(clip.samples.len(), 4);
        assert!((clip.samples[1] - 0.5).abs() < 1e-4);
        assert!((clip.samples[2] + 0.5).abs() < 1e-4);
    }

    #[test]
    fn averages_channels_to_mono() {
        let clip = decode_wav(&encode_pcm16(&[16_384, -16_384, 16_384, 16_384], 16_000, 2)).unwrap();
        assert_eq!(clip.samples.len(), 2);
        assert!(clip.samples[0].abs() < 1e-4);
        assert!((clip.samples[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn takes_what_arrived_when_the_declared_size_is_too_big() {
        let mut bytes = encode_pcm16(&[1000, 2000, 3000], 8_000, 1);
        let at = bytes.len() - 6 - 4;
        bytes[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_wav(&bytes).unwrap().samples.len(), 3);
    }

    #[test]
    fn rejects_what_is_not_a_wav_and_what_is_empty() {
        assert!(decode_wav(b"not audio at all").is_err());
        assert_eq!(decode_wav(&encode_pcm16(&[], 8_000, 1)).unwrap_err(), SpeechError::Silent);
    }
}
