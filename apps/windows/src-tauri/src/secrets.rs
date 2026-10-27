//! Secret storage behind a small trait: the logic (name validation, `Relo/` prefix, size cap) is tested
//! with a fake; only `WinCredStore` touches Windows Credential Manager.

const MAX_VALUE_BYTES: usize = 2560; // CRED_MAX_CREDENTIAL_BLOB_SIZE

pub trait SecretStore {
    fn read(&self, target: &str) -> Result<Option<String>, String>;
    fn write(&self, target: &str, value: &str) -> Result<(), String>;
    /// Deleting a missing entry is Ok.
    fn remove(&self, target: &str) -> Result<(), String>;
}

/// `[a-z0-9._-]{1,64}`, prefixed with `Relo/` (`Relo.dev/` in a dev build, which has its own credentials).
pub fn target_name(name: &str) -> Result<String, String> {
    target_name_for(name, crate::profile::DEV)
}

pub fn target_name_for(name: &str, dev: bool) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(format!("{}{name}", crate::profile::secret_prefix_for(dev)))
    } else {
        Err("invalid secret name (use [a-z0-9._-], 1-64 chars)".into())
    }
}

pub fn get(store: &dyn SecretStore, name: &str) -> Result<Option<String>, String> {
    store.read(&target_name(name)?)
}

pub fn set(store: &dyn SecretStore, name: &str, value: &str) -> Result<(), String> {
    let target = target_name(name)?;
    if value.is_empty() || value.len() > MAX_VALUE_BYTES {
        return Err(format!("secret value must be 1-{MAX_VALUE_BYTES} bytes"));
    }
    store.write(&target, value)
}

pub fn delete(store: &dyn SecretStore, name: &str) -> Result<(), String> {
    store.remove(&target_name(name)?)
}

#[cfg(windows)]
pub struct WinCredStore;

#[cfg(windows)]
mod cred {
    use super::*;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
    use windows::Win32::Security::Credentials::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl SecretStore for WinCredStore {
        fn read(&self, target: &str) -> Result<Option<String>, String> {
            let t = wide(target);
            let mut p: *mut CREDENTIALW = std::ptr::null_mut();
            unsafe {
                match CredReadW(PCWSTR(t.as_ptr()), CRED_TYPE_GENERIC, None, &mut p) {
                    Ok(()) => {
                        let c = &*p;
                        let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
                        let s = String::from_utf8(bytes.to_vec()).map_err(|_| "stored secret is not UTF-8".to_string());
                        CredFree(p as *const _);
                        s.map(Some)
                    }
                    Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
                    Err(e) => Err(format!("credential read failed: {e}")),
                }
            }
        }

        fn write(&self, target: &str, value: &str) -> Result<(), String> {
            let mut t = wide(target);
            let mut user = wide("relo");
            let mut blob = value.as_bytes().to_vec();
            let cred = CREDENTIALW {
                Flags: CRED_FLAGS(0),
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(t.as_mut_ptr()),
                Comment: PWSTR::null(),
                LastWritten: FILETIME::default(),
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: PWSTR::null(),
                UserName: PWSTR(user.as_mut_ptr()),
            };
            unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("credential write failed: {e}"))
        }

        fn remove(&self, target: &str) -> Result<(), String> {
            let t = wide(target);
            match unsafe { CredDeleteW(PCWSTR(t.as_ptr()), CRED_TYPE_GENERIC, None) } {
                Ok(()) => Ok(()),
                Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
                Err(e) => Err(format!("credential delete failed: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake(RefCell<HashMap<String, String>>);
    impl SecretStore for Fake {
        fn read(&self, t: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(t).cloned())
        }
        fn write(&self, t: &str, v: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(t.into(), v.into());
            Ok(())
        }
        fn remove(&self, t: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(t);
            Ok(())
        }
    }

    /// Manual probe against the real Credential Manager: `cargo test real_credential_manager -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_credential_manager_round_trip() {
        let s = WinCredStore;
        delete(&s, "test-probe").unwrap();
        assert_eq!(get(&s, "test-probe").unwrap(), None);
        set(&s, "test-probe", "probe-value-é").unwrap();
        assert_eq!(get(&s, "test-probe").unwrap().as_deref(), Some("probe-value-é"));
        delete(&s, "test-probe").unwrap();
        assert_eq!(get(&s, "test-probe").unwrap(), None);
    }

    #[test]
    fn names_are_restricted_and_prefixed() {
        assert_eq!(target_name_for("device.credential-1_x", false).unwrap(), "Relo/device.credential-1_x");
        assert_eq!(target_name_for("device.credential-1_x", true).unwrap(), "Relo.dev/device.credential-1_x");
        for bad in ["", "Upper", "a b", "a/b", "a\\b", "ü", &"a".repeat(65)] {
            assert!(target_name(bad).is_err(), "{bad}");
        }
        assert!(target_name(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn round_trip_uses_the_prefixed_target() {
        let f = Fake::default();
        assert_eq!(get(&f, "tok").unwrap(), None);
        set(&f, "tok", "s3cret").unwrap();
        assert_eq!(f.0.borrow().keys().cloned().collect::<Vec<_>>(), vec![format!("{}tok", crate::profile::secret_prefix_for(crate::profile::DEV))]);
        assert_eq!(get(&f, "tok").unwrap().as_deref(), Some("s3cret"));
        delete(&f, "tok").unwrap();
        delete(&f, "tok").unwrap();
        assert_eq!(get(&f, "tok").unwrap(), None);
    }

    #[test]
    fn rejects_bad_names_and_values_before_touching_the_store() {
        let f = Fake::default();
        assert!(set(&f, "BAD", "x").is_err());
        assert!(set(&f, "ok", "").is_err());
        assert!(set(&f, "ok", &"x".repeat(2561)).is_err());
        assert!(f.0.borrow().is_empty());
    }
}
