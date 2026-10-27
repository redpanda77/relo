// Relo's voice on Windows: the same voice as Relo for Mac (Phonon 31M, Gradium, Apache-2.0), ported from
// apps/notch/ReloVoice. `engine` is the SpeechEngine trait; `phonon` runs the model with Gradium's `ptts` crate on the CPU;
// `system` is the WinRT fallback; `store` downloads the pinned files; `player` plays one line at a time; `service` is
// ReloVoice (engine choice, the 16-clip cache, cancel); `microphone` and `network` are the quiet rules' OS probes.
//
// The page talks to it through the commands below and the events `voice_progress` (the model's download) and `voice_state`
// (the line being prepared or played); src/voice/index.ts wraps them.

#[cfg(test)]
mod live;

pub mod engine;
pub mod microphone;
pub mod network;
pub mod phonon;
pub mod player;
pub mod service;
pub mod store;
pub mod system;
pub mod wav;

use serde::Serialize;
use service::{Engine, Voice};
use std::sync::Arc;
use store::{ModelStatus, VoiceModel, VoiceModelStore};
use tauri::{AppHandle, Emitter, Manager, State};

/// WinRT and WASAPI want COM on the calling thread; once per thread, multithreaded.
pub(crate) fn com_init() {
    #[cfg(windows)]
    {
        use std::cell::Cell;
        thread_local!(static DONE: Cell<bool> = const { Cell::new(false) });
        DONE.with(|done| {
            if !done.get() {
                done.set(true);
                // Already initialised on this thread (the UI thread): fine either way.
                let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
            }
        });
    }
}

pub struct VoiceHandle(pub Voice, pub Arc<phonon::PhononEngine>);

/// Creates the voice and puts it in Tauri's state. Does not touch the network: `voice_start` does, when the owner's voice
/// mode speaks.
pub fn init(app: &AppHandle) {
    let on_progress = app.clone();
    let on_state = app.clone();
    let store = VoiceModelStore::new(
        VoiceModel::phonon_31m_en(),
        VoiceModelStore::default_root(),
        Arc::new(network::SystemNetwork),
        Arc::new(move |status: ModelStatus| {
            let _ = on_progress.emit("voice_progress", status);
        }),
    );
    let (voice, phonon) = service::build(
        store,
        Arc::new(move |state| {
            let _ = on_state.emit("voice_state", state);
        }),
    );
    app.manage(VoiceHandle(voice, phonon));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    model: ModelStatus,
    state: service::VoiceState,
    engine: &'static str,
    /// The Relo voice's model is in memory now.
    loaded: bool,
    /// Timings of the last Relo-voice line (null before the first).
    last_render: Option<phonon::RenderStats>,
}

#[tauri::command]
pub fn voice_status(voice: State<'_, VoiceHandle>) -> VoiceStatus {
    let v = &voice.0;
    VoiceStatus {
        model: v.store().status(),
        state: v.state(),
        engine: v.engine().as_str(),
        loaded: voice.1.is_loaded(),
        last_render: voice.1.last_stats(),
    }
}

/// At launch (when the voice mode speaks): download the Relo voice when it is missing, on an unmetered connection; else warm it once.
#[tauri::command]
pub fn voice_start(voice: State<'_, VoiceHandle>) {
    voice.0.start();
}

/// Downloads the Relo voice. With `auto`, only on a connection that is not metered (waits for one); otherwise now (the owner asked).
#[tauri::command]
pub fn voice_download(voice: State<'_, VoiceHandle>, auto: Option<bool>) {
    if auto.unwrap_or(false) {
        voice.0.store().download_when_unmetered();
    } else {
        voice.0.store().download();
    }
}

#[tauri::command]
pub fn voice_download_cancel(voice: State<'_, VoiceHandle>) {
    voice.0.store().cancel();
}

/// Deletes the downloaded voice and frees the model.
#[tauri::command]
pub async fn voice_delete(voice: State<'_, VoiceHandle>) -> Result<(), ()> {
    let v = voice.0.clone();
    std::thread::spawn(move || v.delete_model()).join().map_err(|_| ())
}

/// Says `text` as line `line_id` (stops what is being said; a line already rendered replays from memory).
#[tauri::command]
pub fn voice_speak(voice: State<'_, VoiceHandle>, line_id: String, text: String) {
    voice.0.speak(&line_id, &text);
}

/// Stops the line being prepared or played.
#[tauri::command]
pub fn voice_cancel(voice: State<'_, VoiceHandle>) {
    voice.0.stop();
}

/// Settings' preview sentence, rendered fresh.
#[tauri::command]
pub fn voice_preview(voice: State<'_, VoiceHandle>) {
    voice.0.preview();
}

/// "relo" (Phonon once downloaded, the system voice until then) or "system".
#[tauri::command]
pub fn voice_set_engine(voice: State<'_, VoiceHandle>, engine: String) -> Result<(), String> {
    voice.0.set_engine(Engine::parse(&engine).ok_or_else(|| format!("unknown engine {engine}"))?);
    Ok(())
}

/// Something is recording from the default input: the notch does not speak on its own then.
#[tauri::command]
pub async fn voice_microphone_in_use() -> bool {
    microphone::in_use()
}
