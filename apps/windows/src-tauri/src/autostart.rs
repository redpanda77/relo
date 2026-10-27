//! Start-with-Windows via HKCU\...\Run "Relo". The registry sits behind `RunKey`; logic is tested with a fake.

/// The Run value (`Relo`; `Relo (dev)` in a dev build, so it never replaces the installed app's entry).
pub fn value_name() -> &'static str {
    crate::profile::run_value_for(crate::profile::DEV)
}

/// The argument the Run entry launches the app with: this start was Windows signing in, not the owner opening Relo
/// (the Mac's login-item launch: no launch sound, no "Relo is ready").
pub const AT_LOGIN_FLAG: &str = "--at-login";

pub trait RunKey {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, command: &str) -> Result<(), String>;
    /// Removing a missing value is Ok.
    fn remove(&self) -> Result<(), String>;
}

/// The Run command: the quoted exe path (spaces in the path are safe) and `--at-login`.
pub fn command_for(exe: &str) -> String {
    format!("\"{}\" {AT_LOGIN_FLAG}", exe.trim_matches('"'))
}

/// An entry written before `--at-login` existed launches the app without it, so a start at sign-in would play the launch
/// sound. Rewritten when the app runs: only an entry that is on, lacks the flag, and names this exe.
pub fn migrate(key: &dyn RunKey, exe: &str) -> Result<bool, String> {
    let Some(current) = key.read()? else { return Ok(false) };
    let current = current.trim();
    if current.is_empty() || current.split_whitespace().any(|part| part == AT_LOGIN_FLAG) {
        return Ok(false);
    }
    if current.trim_matches('"') != exe.trim_matches('"') {
        return Ok(false); // another exe's entry (a moved install): not this process' to rewrite
    }
    key.write(&command_for(exe))?;
    Ok(true)
}

pub fn is_enabled(key: &dyn RunKey) -> Result<bool, String> {
    Ok(key.read()?.is_some_and(|v| !v.trim().is_empty()))
}

pub fn set_enabled(key: &dyn RunKey, exe: &str, on: bool) -> Result<(), String> {
    if on {
        key.write(&command_for(exe))
    } else {
        key.remove()
    }
}

#[cfg(windows)]
pub struct RegistryRunKey;

#[cfg(windows)]
mod reg {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn open(access: REG_SAM_FLAGS) -> Result<HKEY, String> {
        let sub = wide(SUBKEY);
        let mut k = HKEY::default();
        let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), None, access, &mut k) };
        if r == ERROR_SUCCESS {
            Ok(k)
        } else {
            Err(format!("registry open failed: {}", r.0))
        }
    }

    impl RunKey for RegistryRunKey {
        fn read(&self) -> Result<Option<String>, String> {
            let k = open(KEY_QUERY_VALUE)?;
            let name = wide(value_name());
            let mut size: u32 = 0;
            let mut ty = REG_VALUE_TYPE::default();
            let r = unsafe { RegQueryValueExW(k, PCWSTR(name.as_ptr()), None, Some(&mut ty), None, Some(&mut size)) };
            let out = if r == ERROR_FILE_NOT_FOUND {
                Ok(None)
            } else if r != ERROR_SUCCESS {
                Err(format!("registry read failed: {}", r.0))
            } else {
                let mut buf = vec![0u16; (size as usize).div_ceil(2)];
                let mut sz = size;
                let r = unsafe {
                    RegQueryValueExW(k, PCWSTR(name.as_ptr()), None, None, Some(buf.as_mut_ptr() as *mut u8), Some(&mut sz))
                };
                if r != ERROR_SUCCESS {
                    Err(format!("registry read failed: {}", r.0))
                } else {
                    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    Ok(Some(String::from_utf16_lossy(&buf[..end])))
                }
            };
            unsafe { let _ = RegCloseKey(k); }
            out
        }

        fn write(&self, command: &str) -> Result<(), String> {
            let k = open(KEY_SET_VALUE)?;
            let name = wide(value_name());
            let data: Vec<u8> = wide(command).iter().flat_map(|c| c.to_le_bytes()).collect();
            let r = unsafe { RegSetValueExW(k, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&data)) };
            unsafe { let _ = RegCloseKey(k); }
            if r == ERROR_SUCCESS { Ok(()) } else { Err(format!("registry write failed: {}", r.0)) }
        }

        fn remove(&self) -> Result<(), String> {
            let k = open(KEY_SET_VALUE)?;
            let name = wide(value_name());
            let r = unsafe { RegDeleteValueW(k, PCWSTR(name.as_ptr())) };
            unsafe { let _ = RegCloseKey(k); }
            if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND { Ok(()) } else { Err(format!("registry delete failed: {}", r.0)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake(RefCell<Option<String>>);
    impl RunKey for Fake {
        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.0.borrow().clone())
        }
        fn write(&self, c: &str) -> Result<(), String> {
            *self.0.borrow_mut() = Some(c.into());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            *self.0.borrow_mut() = None;
            Ok(())
        }
    }

    #[test]
    fn quotes_the_exe_path() {
        assert_eq!(command_for(r"C:\Program Files\Relo\relo.exe"), r#""C:\Program Files\Relo\relo.exe" --at-login"#);
        assert_eq!(command_for(r#""C:\a.exe""#), r#""C:\a.exe" --at-login"#);
    }

    #[test]
    fn an_older_entry_gains_the_flag_once() {
        let f = Fake::default();
        assert!(!migrate(&f, r"C:\r.exe").unwrap(), "nothing to migrate when off");
        *f.0.borrow_mut() = Some(r#""C:\r.exe""#.into());
        assert!(migrate(&f, r"C:\r.exe").unwrap());
        assert_eq!(f.0.borrow().as_deref(), Some(r#""C:\r.exe" --at-login"#));
        assert!(!migrate(&f, r"C:\r.exe").unwrap(), "already carries the flag");
    }

    #[test]
    fn another_exes_entry_is_left_alone() {
        let f = Fake::default();
        *f.0.borrow_mut() = Some(r#""C:\elsewhere\relo.exe""#.into());
        assert!(!migrate(&f, r"C:\r.exe").unwrap());
        assert_eq!(f.0.borrow().as_deref(), Some(r#""C:\elsewhere\relo.exe""#));
    }

    #[test]
    fn toggle_round_trip() {
        let f = Fake::default();
        assert!(!is_enabled(&f).unwrap());
        set_enabled(&f, r"C:\r.exe", true).unwrap();
        assert!(is_enabled(&f).unwrap());
        assert_eq!(f.0.borrow().as_deref(), Some(r#""C:\r.exe" --at-login"#));
        set_enabled(&f, r"C:\r.exe", false).unwrap();
        set_enabled(&f, r"C:\r.exe", false).unwrap();
        assert!(!is_enabled(&f).unwrap());
    }
}
