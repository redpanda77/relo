//! Five-band spectrum from mono samples: Hann window, radix-2 FFT, log-spaced bands, dB scaled to 0..1.
//! No dependencies, so it is cheap and testable with a synthetic signal.

pub const BANDS: usize = 5;
/// Band edges in Hz: bass, low mids, mids, upper mids, highs.
pub const EDGES: [f32; BANDS + 1] = [30.0, 150.0, 500.0, 2000.0, 6000.0, 16000.0];
pub const FFT_SIZE: usize = 1024;

/// In-place iterative radix-2 FFT. `re.len()` must be a power of two and equal `im.len()`.
pub fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

/// Band levels 0..1 for the last `FFT_SIZE` samples (shorter input is zero-padded).
pub fn bands(samples: &[f32], sample_rate: f32) -> [f32; BANDS] {
    let mut re = vec![0.0f32; FFT_SIZE];
    let mut im = vec![0.0f32; FFT_SIZE];
    let take = samples.len().min(FFT_SIZE);
    let src = &samples[samples.len() - take..];
    for (i, s) in src.iter().enumerate() {
        let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos();
        re[i] = s * w;
    }
    fft(&mut re, &mut im);
    let hz_per_bin = sample_rate / FFT_SIZE as f32;
    // A full-scale sine with a Hann window peaks at N/4.
    let norm = FFT_SIZE as f32 / 4.0;
    let mut out = [0.0f32; BANDS];
    for (b, o) in out.iter_mut().enumerate() {
        let lo = ((EDGES[b] / hz_per_bin).ceil() as usize).max(1);
        let hi = ((EDGES[b + 1] / hz_per_bin).floor() as usize).min(FFT_SIZE / 2 - 1);
        if hi < lo {
            continue;
        }
        let mut peak = 0.0f32;
        for k in lo..=hi {
            peak = peak.max((re[k] * re[k] + im[k] * im[k]).sqrt() / norm);
        }
        let db = 20.0 * (peak + 1e-9).log10();
        // -60 dB is silence, -6 dB (a loud signal) fills the bar.
        *o = ((db + 60.0) / 54.0).clamp(0.0, 1.0);
    }
    out
}

/// Fast attack, slow release, so bars jump with the beat and fall gently.
pub fn smooth(prev: [f32; BANDS], next: [f32; BANDS]) -> [f32; BANDS] {
    let mut o = [0.0; BANDS];
    for i in 0..BANDS {
        o[i] = if next[i] > prev[i] { prev[i] + (next[i] - prev[i]) * 0.7 } else { prev[i] + (next[i] - prev[i]) * 0.2 };
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, amp: f32, rate: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate).sin()).collect()
    }

    fn argmax(b: &[f32; BANDS]) -> usize {
        b.iter().enumerate().max_by(|a, c| a.1.partial_cmp(c.1).unwrap()).unwrap().0
    }

    #[test]
    fn silence_is_zero() {
        assert_eq!(bands(&vec![0.0; FFT_SIZE], 48_000.0), [0.0; BANDS]);
        assert_eq!(bands(&[], 48_000.0), [0.0; BANDS]);
    }

    #[test]
    fn each_tone_lights_its_band() {
        for (hz, band) in [(100.0, 0), (300.0, 1), (1000.0, 2), (4000.0, 3), (10_000.0, 4)] {
            let b = bands(&sine(hz, 0.5, 48_000.0, FFT_SIZE), 48_000.0);
            assert_eq!(argmax(&b), band, "{hz} Hz -> {b:?}");
            assert!(b[band] > 0.6, "{hz} Hz is loud: {b:?}");
        }
    }

    #[test]
    fn louder_is_higher_and_two_tones_light_two_bands() {
        let quiet = bands(&sine(1000.0, 0.01, 44_100.0, FFT_SIZE), 44_100.0)[2];
        let loud = bands(&sine(1000.0, 0.5, 44_100.0, FFT_SIZE), 44_100.0)[2];
        assert!(loud > quiet);
        let a = sine(100.0, 0.4, 48_000.0, FFT_SIZE);
        let c = sine(4000.0, 0.4, 48_000.0, FFT_SIZE);
        let mix: Vec<f32> = a.iter().zip(&c).map(|(x, y)| x + y).collect();
        let b = bands(&mix, 48_000.0);
        assert!(b[0] > 0.5 && b[3] > 0.5 && b[2] < 0.3, "{b:?}");
    }

    #[test]
    fn smoothing_attacks_fast_and_releases_slowly() {
        let up = smooth([0.0; BANDS], [1.0; BANDS]);
        let down = smooth([1.0; BANDS], [0.0; BANDS]);
        assert!(up[0] > 0.6);
        assert!(down[0] > 0.7);
    }
}
