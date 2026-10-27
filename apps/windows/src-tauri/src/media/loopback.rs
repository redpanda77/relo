//! Visualizer feed: WASAPI loopback capture of the default render device, folded to five bands (fft.rs) and sent to
//! the page as `media_bands`. Runs only while the page asks for it (`media_visualizer(true)`): the notch visible and
//! music playing. Stopping releases the device, so a hidden or paused notch costs nothing.

use super::fft;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::core::Result as WResult;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

static RUN: AtomicBool = AtomicBool::new(false);
static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

pub fn set(app: &AppHandle, on: bool) {
    let mut t = THREAD.lock().unwrap();
    if on {
        if RUN.swap(true, Ordering::SeqCst) && t.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let app = app.clone();
        *t = std::thread::Builder::new()
            .name("relo-media-loopback".into())
            .spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                if let Err(e) = capture(&app) {
                    eprintln!("relo: audio loopback unavailable: {e}");
                    let _ = app.emit("media_bands", [0.0f32; fft::BANDS]);
                }
                RUN.store(false, Ordering::SeqCst);
            })
            .ok();
    } else {
        RUN.store(false, Ordering::SeqCst);
        if let Some(h) = t.take() {
            let _ = h.join();
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Fmt {
    F32,
    I16,
    I32,
}

fn capture(app: &AppHandle) -> WResult<()> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
        let fmt_ptr = client.GetMixFormat()?;
        let f = *fmt_ptr;
        let (channels, rate, bits) = (f.nChannels as usize, f.nSamplesPerSec as f32, f.wBitsPerSample);
        let tag = if f.wFormatTag == 0xFFFE {
            // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID's first field is the real tag.
            (*(fmt_ptr as *const WAVEFORMATEXTENSIBLE)).SubFormat.data1 as u16
        } else {
            f.wFormatTag
        };
        let sample = match (tag, bits) {
            (3, 32) => Fmt::F32,
            (1, 16) => Fmt::I16,
            (1, 32) => Fmt::I32,
            _ => {
                CoTaskMemFree(Some(fmt_ptr as *const _));
                return Err(windows::core::Error::new(windows::Win32::Foundation::E_FAIL, "unsupported mix format"));
            }
        };
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt_ptr, None)?;
        CoTaskMemFree(Some(fmt_ptr as *const _));
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let mut ring: Vec<f32> = vec![0.0; fft::FFT_SIZE];
        let mut bands = [0.0f32; fft::BANDS];
        let mut last_sent = [1.0f32; fft::BANDS];
        let mut last_audio = Instant::now();
        while RUN.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(33));
            let mut got = false;
            loop {
                let n = cap.GetNextPacketSize()?;
                if n == 0 {
                    break;
                }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                for i in 0..frames as usize {
                    let mut sum = 0.0f32;
                    if !silent {
                        for c in 0..channels {
                            let k = i * channels + c;
                            sum += match sample {
                                Fmt::F32 => *(data as *const f32).add(k),
                                Fmt::I16 => *(data as *const i16).add(k) as f32 / 32768.0,
                                Fmt::I32 => *(data as *const i32).add(k) as f32 / 2_147_483_648.0,
                            };
                        }
                    }
                    ring.push(sum / channels as f32);
                }
                got = true;
                cap.ReleaseBuffer(frames)?;
            }
            if got {
                last_audio = Instant::now();
            } else if last_audio.elapsed() > Duration::from_millis(100) {
                // Loopback delivers nothing while the device is silent: feed silence so the bars fall.
                ring.extend(std::iter::repeat(0.0).take(((rate * 0.033) as usize).min(4096)));
            }
            if ring.len() > fft::FFT_SIZE * 4 {
                let cut = ring.len() - fft::FFT_SIZE;
                ring.drain(..cut);
            }
            bands = fft::smooth(bands, fft::bands(&ring, rate));
            let moved = bands.iter().zip(&last_sent).any(|(a, b)| (a - b).abs() > 0.01);
            if moved {
                let _ = app.emit("media_bands", bands);
                last_sent = bands;
            }
        }
        let _ = client.Stop();
        let _ = app.emit("media_bands", [0.0f32; fft::BANDS]);
    }
    Ok(())
}
