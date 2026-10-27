// Port of PhononEngine.swift: Phonon 31M (Gradium, Apache-2.0) through Gradium's own Rust runtime, the `ptts` crate. The Mac
// runs it on the GPU; here it runs on the GPU through Vulkan when this build has it and the machine has a driver, and on the
// CPU otherwise (on a few cores, so the PC stays responsive). Loaded when a line needs it (about 0.1 s from disk), kept while lines keep coming, unloaded after `idle` seconds:
// staying warm would hold the model for nothing the owner can hear.

use super::engine::{Cancel, SpeechEngine, SpeechError, SpokenClip};
use ptts::checkpoint::{Checkpoint, ResolveOptions};
use ptts::preprocess::Lang;
use ptts::synth::{DeviceKind, Quant, Synth};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once};
use std::time::{Duration, Instant};

/// What the last render cost (for the voice_status command and the timing example).
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStats {
    /// Reading and building the model; zero when it was already loaded.
    pub load_ms: u64,
    /// From the start of the render (after the load) to the first audio.
    pub first_audio_ms: u64,
    pub total_ms: u64,
    pub audio_secs: f64,
    /// "vulkan" or "cpu": where this render ran.
    pub device: &'static str,
}

struct Slot {
    synth: Option<Arc<Synth>>,
    /// When the loaded model is dropped; None while a render runs or nothing is loaded.
    deadline: Option<Instant>,
    watcher: bool,
    closed: bool,
}

struct Shared {
    slot: Mutex<Slot>,
    cv: Condvar,
}

pub struct PhononEngine {
    dir: PathBuf,
    idle: Duration,
    shared: Arc<Shared>,
    /// One line at a time: a prewarm and a real line never run the model together.
    busy: Mutex<()>,
    /// Set when the GPU failed to load or to render a line: every later load goes straight to the CPU.
    cpu_only: AtomicBool,
    /// The device the loaded model runs on.
    device: Mutex<&'static str>,
    stats: Mutex<Option<RenderStats>>,
}

impl PhononEngine {
    pub fn new(model_directory: PathBuf) -> Self {
        Self::with_idle(model_directory, Duration::from_secs(300))
    }

    pub fn with_idle(model_directory: PathBuf, idle: Duration) -> Self {
        Self {
            dir: model_directory,
            idle,
            shared: Arc::new(Shared {
                slot: Mutex::new(Slot { synth: None, deadline: None, watcher: false, closed: false }),
                cv: Condvar::new(),
            }),
            busy: Mutex::new(()),
            cpu_only: AtomicBool::new(false),
            device: Mutex::new("cpu"),
            stats: Mutex::new(None),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.shared.slot.lock().unwrap().synth.is_some()
    }

    pub fn device_label(&self) -> &'static str {
        *self.device.lock().unwrap()
    }

    pub fn last_stats(&self) -> Option<RenderStats> {
        *self.stats.lock().unwrap()
    }

    fn loaded(&self) -> Result<(Arc<Synth>, u64), SpeechError> {
        if let Some(s) = self.shared.slot.lock().unwrap().synth.clone() {
            return Ok((s, 0));
        }
        if !self.dir.join("model.safetensors").is_file() {
            return Err(SpeechError::ModelMissing);
        }
        let started = Instant::now();
        // The same f32 weights, config and default voice the Mac loads (see store.rs for the pinned revision and hashes).
        let checkpoint = Checkpoint::resolve(&self.dir, ResolveOptions { quant: Quant::F32, weights: None })
            .map_err(|e| SpeechError::Engine(format!("Could not open the Relo voice: {e}")))?;
        limit_threads();
        // The GPU first, the CPU when there is no GPU, no driver, or this build has no GPU backend: the line is still said.
        let mut built = None;
        let mut last_error = String::new();
        for (kind, label) in self.devices() {
            // A missing driver or a failing GPU can error or panic inside the runtime; neither may stop the voice.
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                checkpoint.builder(Lang::En).device(kind).build()
            }));
            match attempt {
                Ok(Ok(synth)) => {
                    built = Some((synth, label));
                    break;
                }
                Ok(Err(e)) => last_error = e.to_string(),
                Err(_) => last_error = format!("the {label} backend crashed while loading"),
            }
        }
        let Some((mut synth, label)) = built else {
            return Err(SpeechError::Engine(format!("Could not load the Relo voice: {last_error}")));
        };
        checkpoint.register_voices(&mut synth);
        *self.device.lock().unwrap() = label;
        let synth = Arc::new(synth);
        let mut slot = self.shared.slot.lock().unwrap();
        slot.synth = Some(synth.clone());
        if !slot.watcher {
            slot.watcher = true;
            let shared = self.shared.clone();
            std::thread::Builder::new()
                .name("relo-voice-idle".into())
                .spawn(move || watch(shared))
                .ok();
        }
        Ok((synth, started.elapsed().as_millis() as u64))
    }

    /// Devices to try, in order. `RELO_VOICE_DEVICE=cpu` forces the CPU (diagnostics).
    fn devices(&self) -> Vec<(DeviceKind, &'static str)> {
        let forced_cpu = std::env::var("RELO_VOICE_DEVICE").is_ok_and(|v| v.eq_ignore_ascii_case("cpu"));
        // `check_device` errors, without touching a device, when this build has no Vulkan backend.
        let gpu = !forced_cpu && !self.cpu_only.load(Ordering::SeqCst) && Quant::F32.check_device(DeviceKind::Vulkan).is_ok();
        let mut devices = Vec::new();
        if gpu {
            devices.push((DeviceKind::Vulkan, "vulkan"));
        }
        devices.push((DeviceKind::Cpu, "cpu"));
        devices
    }

    fn schedule_unload(&self) {
        let mut slot = self.shared.slot.lock().unwrap();
        if slot.synth.is_some() {
            slot.deadline = Some(Instant::now() + self.idle);
        }
        self.shared.cv.notify_all();
    }
}

/// Phonon's CPU kernels fan out over every logical core by default, which pins the whole PC while a line renders, and is
/// slower for it (measured on 16 threads: 3.6x real time, against 8.5x on 3 to 5: the workers spin and fight over cores).
/// Half the physical cores, at most 4, renders many times faster than the line plays and leaves the rest to the owner's
/// work. Once, before the first tensor
/// op (the pool is sized then); `RELO_VOICE_THREADS` or `RAYON_NUM_THREADS` override.
fn limit_threads() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let chosen = std::env::var("RELO_VOICE_THREADS").ok().and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0);
        if chosen.is_none() && std::env::var_os("RAYON_NUM_THREADS").is_some() {
            return;
        }
        let threads = chosen.unwrap_or_else(|| {
            let mut system = sysinfo::System::new();
            system.refresh_cpu_all();
            let physical = system.physical_core_count().unwrap_or_else(|| xn::get_num_cpus() / 2);
            (physical / 2).clamp(2, 4)
        });
        xn::set_num_threads(threads);
    });
}

/// Drops the model once its idle deadline passes; ends when the engine is dropped.
fn watch(shared: Arc<Shared>) {
    let mut slot = shared.slot.lock().unwrap();
    loop {
        if slot.closed {
            return;
        }
        match slot.deadline {
            None => slot = shared.cv.wait(slot).unwrap(),
            Some(at) => {
                let now = Instant::now();
                if now >= at {
                    slot.synth = None;
                    slot.deadline = None;
                } else {
                    slot = shared.cv.wait_timeout(slot, at - now).unwrap().0;
                }
            }
        }
    }
}

impl Drop for PhononEngine {
    fn drop(&mut self) {
        let mut slot = self.shared.slot.lock().unwrap();
        slot.closed = true;
        slot.synth = None;
        self.shared.cv.notify_all();
    }
}

impl PhononEngine {
    fn render_once(
        &self,
        text: &str,
        cancel: &Cancel,
        on_chunk: &mut dyn FnMut(&[f32], u32),
        delivered: &mut bool,
    ) -> Result<SpokenClip, SpeechError> {
        let (synth, load_ms) = self.loaded()?;
        let rate = synth.sample_rate();
        let started = Instant::now();
        let mut first = None;
        let mut samples = Vec::new();
        let stream = synth.stream(text).map_err(|e| SpeechError::Engine(e.to_string()))?;
        for chunk in stream {
            if cancel.is_cancelled() {
                return Err(SpeechError::Cancelled);
            }
            let chunk = chunk.map_err(|e| SpeechError::Engine(e.to_string()))?;
            if chunk.is_empty() {
                continue;
            }
            first.get_or_insert_with(|| started.elapsed());
            *delivered = true;
            on_chunk(&chunk, rate);
            samples.extend_from_slice(&chunk);
        }
        if samples.is_empty() {
            return Err(SpeechError::Silent);
        }
        let clip = SpokenClip { samples, sample_rate: rate };
        *self.stats.lock().unwrap() = Some(RenderStats {
            load_ms,
            first_audio_ms: first.map_or(0, |d| d.as_millis() as u64),
            total_ms: started.elapsed().as_millis() as u64,
            audio_secs: clip.duration_secs(),
            device: self.device_label(),
        });
        Ok(clip)
    }
}

impl SpeechEngine for PhononEngine {
    fn render_stream(
        &self,
        text: &str,
        cancel: &Cancel,
        on_chunk: &mut dyn FnMut(&[f32], u32),
    ) -> Result<SpokenClip, SpeechError> {
        let _one_at_a_time = self.busy.lock().unwrap();
        if cancel.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        // A render in progress keeps the model: no deadline until it ends.
        self.shared.slot.lock().unwrap().deadline = None;
        let mut delivered = false;
        let mut result = self.render_once(text, cancel, on_chunk, &mut delivered);
        // The GPU loaded but failed on this line before any audio left: the CPU says it (and says every later line).
        if matches!(result, Err(SpeechError::Engine(_))) && !delivered && self.device_label() != "cpu" {
            self.cpu_only.store(true, Ordering::SeqCst);
            {
                let mut slot = self.shared.slot.lock().unwrap();
                slot.synth = None;
            }
            result = self.render_once(text, cancel, on_chunk, &mut delivered);
        }
        self.schedule_unload();
        result
    }

    fn unload(&self) {
        let mut slot = self.shared.slot.lock().unwrap();
        slot.synth = None;
        slot.deadline = None;
        self.shared.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_model_is_reported_not_loaded() {
        let engine = PhononEngine::new(std::env::temp_dir().join("relo-voice-test-no-such-model"));
        assert_eq!(engine.render("Hello.", &Cancel::new()).unwrap_err(), SpeechError::ModelMissing);
        assert!(!engine.is_loaded());
    }

    #[test]
    fn a_cancelled_line_is_not_rendered() {
        let engine = PhononEngine::new(std::env::temp_dir().join("relo-voice-test-no-such-model"));
        let cancel = Cancel::new();
        cancel.cancel();
        assert_eq!(engine.render("Hello.", &cancel).unwrap_err(), SpeechError::Cancelled);
    }
}
