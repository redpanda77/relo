//! Updates (the Mac's ReloUpdater over Sparkle, here tauri-plugin-updater).
//!
//! The page decides what to check (the feed address from UpdatePolicy in src/client/updatePolicy.ts) and whether to
//! install by itself; this module owns the work: an hourly check, the download, the install, and the line after an
//! update. Like Sparkle it never checks without a signing key: while `plugins.updater.pubkey` in tauri.conf.json
//! is the TODO placeholder, nothing is asked of the network.
//!
//! Events to the notch: `update_state` { state: "none" | "available" | "ready" | "error", version?, message? }.

use crate::launch;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const CHECK_EVERY: Duration = Duration::from_secs(3600);
const FEED_PATH: &str = "/windows/update.json";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub state: &'static str,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
struct Inner {
    feed: Option<Url>,
    auto_install: bool,
    started: bool,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

static INNER: Mutex<Option<Inner>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Inner) -> T) -> T {
    let mut guard = INNER.lock().unwrap();
    f(guard.get_or_insert_with(Inner::default))
}

/// The feed is `<origin>/windows/update.json` on a server origin the app would talk to.
pub fn validate_feed(s: &str) -> Option<Url> {
    let u = Url::parse(s).ok()?;
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let origin = u.origin().ascii_serialization();
    (launch::parse_origin(&origin).as_deref() == Some(origin.as_str()) && u.path() == FEED_PATH && u.query().is_none()).then_some(u)
}

/// True while the configured key is missing or the committed placeholder.
pub fn key_is_placeholder(pubkey: &str) -> bool {
    let k = pubkey.trim();
    k.is_empty() || k.starts_with("TODO")
}

fn configured_key(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn state(state: &'static str, version: Option<String>, message: Option<String>) -> UpdateState {
    UpdateState { state, version, message }
}

fn emit(app: &AppHandle, s: &'static str, version: Option<String>, message: Option<String>) -> UpdateState {
    let st = state(s, version, message);
    let _ = app.emit_to("notch", "update_state", st.clone());
    st
}

/// One check. The state it ends in: "off" (no feed or no signing key: nothing was asked of the network), "none",
/// "available", "ready" or "error". Everything but "off" is also sent to the notch as `update_state`.
async fn check(app: &AppHandle) -> UpdateState {
    let (feed, auto) = with(|i| (i.feed.clone(), i.auto_install));
    let Some(feed) = feed else { return state("off", None, None) };
    if key_is_placeholder(&configured_key(app)) {
        eprintln!("relo: updates are off in this build (no updater public key)");
        return state("off", None, None);
    }
    let built = app.updater_builder().endpoints(vec![feed]).and_then(|b| b.build());
    let updater = match built {
        Ok(u) => u,
        Err(e) => return emit(app, "error", None, Some(format!("updates are unavailable: {e}"))),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let already = with(|i| i.update.as_ref().is_some_and(|u| u.version == version));
            if already {
                let ready = with(|i| i.bytes.is_some());
                return state(if ready { "ready" } else { "available" }, Some(version), None);
            }
            with(|i| {
                i.update = Some(update.clone());
                i.bytes = None;
            });
            let mut out = emit(app, "available", Some(version.clone()), None);
            if auto {
                match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => {
                        with(|i| i.bytes = Some(bytes));
                        out = emit(app, "ready", Some(version), None);
                    }
                    Err(e) => eprintln!("relo: update download failed: {e}"),
                }
            }
            out
        }
        Ok(None) => emit(app, "none", None, None),
        Err(e) => {
            eprintln!("relo: update check failed: {e}");
            state("error", None, Some(e.to_string()))
        }
    }
}

/// Feed and policy from the page; starts the hourly loop once and checks right away.
#[tauri::command]
pub fn updater_configure(app: AppHandle, feed: Option<String>, auto_install: bool) -> Result<(), String> {
    let feed = match feed {
        Some(f) => Some(validate_feed(&f).ok_or("not an update feed address")?),
        None => None,
    };
    let start = with(|i| {
        let changed = i.feed != feed;
        i.feed = feed;
        i.auto_install = auto_install;
        if changed {
            i.update = None;
            i.bytes = None;
        }
        !std::mem::replace(&mut i.started, true)
    });
    let handle = app.clone();
    if start {
        tauri::async_runtime::spawn(async move {
            loop {
                check(&handle).await;
                tokio_sleep(CHECK_EVERY).await;
            }
        });
    } else {
        tauri::async_runtime::spawn(async move { check(&handle).await });
    }
    Ok(())
}

async fn tokio_sleep(d: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await.ok();
}

#[tauri::command]
pub async fn updater_check_now(app: AppHandle) {
    check(&app).await;
}

/// Settings' "Check for Updates...": the same check, with its outcome returned for the page to say.
#[tauri::command]
pub async fn updater_check_manual(app: AppHandle) -> UpdateState {
    check(&app).await
}

/// Whether this build takes updates at all (a signing key is configured); Settings hides the controls when not.
#[tauri::command]
pub fn updater_enabled(app: AppHandle) -> bool {
    !key_is_placeholder(&configured_key(&app))
}

/// Restart now: downloads if needed, then installs (the installer closes the app and starts the new one).
#[tauri::command]
pub async fn updater_install() -> Result<(), String> {
    let (update, bytes) = with(|i| (i.update.clone(), i.bytes.take()));
    let update = update.ok_or("no update is waiting")?;
    let bytes = match bytes {
        Some(b) => b,
        None => update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?,
    };
    update.install(bytes).map_err(|e| e.to_string())
}

// ---- after an update ----

fn state_file() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(crate::profile::app_dir()).join("last-launched-version"))
}

/// Whether this launch is the first of a new version: the previous version, when it differs.
pub fn changed_version(previous: Option<&str>, now: &str) -> bool {
    previous.map(str::trim).is_some_and(|p| !p.is_empty() && p != now)
}

/// The first launch of a new version outside local mode (the Mac's `noteLaunchedVersion`): the version for the "Updated to X"
/// line, with no agents suffix and no agent refresh (only Relo on this PC refreshes the agents' files, and it reports that
/// itself with `local_updated`, so local mode answers None here). None when the version did not change.
#[tauri::command]
pub async fn updater_after_update(app: AppHandle) -> Option<AfterUpdate> {
    let now = app.package_info().version.to_string();
    let path = state_file()?;
    let previous = std::fs::read_to_string(&path).ok();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, &now);
    if !changed_version(previous.as_deref(), &now) || crate::local::local_state_get().mode {
        return None;
    }
    Some(AfterUpdate { version: now, agents: "notApplicable" })
}

#[derive(Serialize, Debug)]
pub struct AfterUpdate {
    pub version: String,
    pub agents: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_must_be_the_servers_update_json() {
        assert!(validate_feed("https://relo.example.com/windows/update.json").is_some());
        assert!(validate_feed("http://127.0.0.1:8180/windows/update.json").is_some());
        assert!(validate_feed("http://example.com/windows/update.json").is_none());
        assert!(validate_feed("https://relo.example.com/mac/appcast.xml").is_none());
        assert!(validate_feed("https://relo.example.com/windows/update.json?x=1").is_none());
        assert!(validate_feed("file:///C:/update.json").is_none());
    }

    #[test]
    fn a_placeholder_key_never_checks() {
        assert!(key_is_placeholder(""));
        assert!(key_is_placeholder("  TODO_REPLACE_WITH_MINISIGN_PUBLIC_KEY"));
        assert!(!key_is_placeholder("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDEyMzQ="));
    }

    #[test]
    fn only_a_changed_version_counts_as_updated() {
        assert!(!changed_version(None, "0.2.0"));
        assert!(!changed_version(Some("0.2.0\n"), "0.2.0"));
        assert!(changed_version(Some("0.1.9"), "0.2.0"));
        assert!(!changed_version(Some(""), "0.2.0"));
    }
}
