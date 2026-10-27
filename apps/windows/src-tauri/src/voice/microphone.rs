// Port of Microphone.swift: whether something is recording from the default input (a call, dictation): then the notch does
// not speak on its own. On Windows that is an active WASAPI capture session on the default capture endpoint (IAudioSessionManager2),
// other than Relo's own. A press of play always speaks.

#[cfg(windows)]
pub fn in_use() -> bool {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    super::com_init();
    let check = || -> windows::core::Result<bool> {
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            let me = std::process::id();
            for i in 0..sessions.GetCount()? {
                let session = sessions.GetSession(i)?;
                if session.GetState()? != AudioSessionStateActive {
                    continue;
                }
                if let Ok(two) = session.cast::<IAudioSessionControl2>() {
                    if two.GetProcessId().unwrap_or(0) == me {
                        continue;
                    }
                }
                return Ok(true);
            }
            Ok(false)
        }
    };
    // Cannot tell (no input device, no access): speak, as the Mac does when the device does not report.
    check().unwrap_or(false)
}

#[cfg(not(windows))]
pub fn in_use() -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn the_default_capture_endpoint_can_be_asked() {
        // True or false depends on the machine; asking must not panic or hang.
        let _ = super::in_use();
    }
}
