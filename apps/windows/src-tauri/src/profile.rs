//! Dev build or installed app. A debug build (`tauri dev`) must never touch what the installed Relo keeps: both used to
//! share the identifier `com.example.relo.windows`, so they shared the WebView data folders (an uninstall with "delete
//! data" wiped the dev app's), the Run value, the credentials and the app's folders under `%APPDATA%` / `%LOCALAPPDATA%`.
//!
//! The dev build has its own identifier (`tauri.dev.conf.json`, merged by `pnpm dev:app`) and, through this module, its own
//! names for everything the app itself owns. What the CLI owns stays put in both: `%LOCALAPPDATA%\Relo\bin\relo.cmd`, the
//! local server's data root and the CLI's own config.

/// The installed app's identifier (tauri.conf.json).
pub const IDENTIFIER: &str = "com.example.relo.windows";
/// The dev build's (tauri.dev.conf.json).
pub const DEV_IDENTIFIER: &str = "com.example.relo.windows.dev";

/// True in a debug build, which is what `tauri dev` runs.
pub const DEV: bool = cfg!(debug_assertions);

/// The identifier a build must run under.
pub const fn identifier_for(dev: bool) -> &'static str {
    if dev {
        DEV_IDENTIFIER
    } else {
        IDENTIFIER
    }
}

/// The app's own folder under `%APPDATA%` and `%LOCALAPPDATA%` (settings, logs, shelf, state files).
pub const fn app_dir_for(dev: bool) -> &'static str {
    if dev {
        "Relo.dev"
    } else {
        "Relo"
    }
}

/// Prefix of the Credential Manager targets.
pub const fn secret_prefix_for(dev: bool) -> &'static str {
    if dev {
        "Relo.dev/"
    } else {
        "Relo/"
    }
}

/// Name of the start-with-Windows value under `HKCU\...\Run`.
pub const fn run_value_for(dev: bool) -> &'static str {
    if dev {
        "Relo (dev)"
    } else {
        "Relo"
    }
}

/// This build's folder name (see `app_dir_for`).
pub const fn app_dir() -> &'static str {
    app_dir_for(DEV)
}

/// Whether the identifier the app was started with is the one this build must have. A debug build started without the dev
/// config (plain `tauri dev`) would use the installed app's WebView data.
pub fn identifier_matches(configured: &str, dev: bool) -> bool {
    configured == identifier_for(dev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_and_installed_never_share_a_name() {
        assert_ne!(identifier_for(true), identifier_for(false));
        assert_ne!(app_dir_for(true), app_dir_for(false));
        assert_ne!(secret_prefix_for(true), secret_prefix_for(false));
        assert_ne!(run_value_for(true), run_value_for(false));
        assert_eq!(identifier_for(false), "com.example.relo.windows");
        assert_eq!(app_dir_for(false), "Relo");
        assert_eq!(secret_prefix_for(false), "Relo/");
        assert_eq!(run_value_for(false), "Relo");
    }

    #[test]
    fn a_debug_build_refuses_the_installed_identifier() {
        assert!(identifier_matches("com.example.relo.windows.dev", true));
        assert!(!identifier_matches("com.example.relo.windows", true));
        assert!(identifier_matches("com.example.relo.windows", false));
        assert!(!identifier_matches("com.example.relo.windows.dev", false));
    }

    #[test]
    fn the_dev_conf_names_the_dev_identifier() {
        let text = include_str!("../tauri.dev.conf.json");
        let v: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["identifier"], DEV_IDENTIFIER);
        let prod: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(prod["identifier"], IDENTIFIER);
    }
}
