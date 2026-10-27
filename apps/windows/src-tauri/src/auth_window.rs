//! Sign-in inside the app (the Mac's BrowserSignInSession): a small window loads the server's
//! `/mobile/sign-in` page; the approval ends in a redirect to `relo://auth/callback?...`, which this module
//! intercepts before the webview can leave the page, closes the window and hands to the notch (the same
//! validation and event as a link forwarded by the OS). Closing the window cancels sign-in.
//!
//! The window loads a remote page, so it has its own capability with no permissions (capabilities/signin.json):
//! it cannot call any app command. It shares the app's WebView2 profile, so an owner already signed in to the
//! web app only confirms (the Mac sets prefersEphemeralWebBrowserSession = false for the same reason).

use crate::{launch, os};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

pub const LABEL: &str = "signin";

/// The finished flag of the window that is open now (a replaced window must not report a cancel).
static CURRENT: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// `<origin>/mobile/sign-in?...` on a server origin the app would talk to (https, or http on this network).
pub fn validate_sign_in_url(s: &str) -> Option<Url> {
    if s.len() > 4096 {
        return None;
    }
    let u = Url::parse(s).ok()?;
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let origin = launch::parse_origin(&u.origin().ascii_serialization())?;
    (origin == u.origin().ascii_serialization() && u.path() == "/mobile/sign-in" && u.fragment().is_none()).then_some(u)
}

/// What the window may navigate to: web pages, and the callback (handled, not loaded).
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    Allow,
    /// A valid `relo://auth/callback`: hand it over and close.
    Callback(String),
    Block,
}

pub fn classify_navigation(url: &Url) -> Nav {
    match url.scheme() {
        "https" | "http" | "about" => Nav::Allow,
        "relo" => match launch::validate_auth_callback(url.as_str()) {
            Some(valid) => Nav::Callback(valid),
            None => Nav::Block,
        },
        _ => Nav::Block,
    }
}

#[derive(Serialize, Clone)]
struct Closed {}

fn close_later(app: &AppHandle) {
    let app = app.clone();
    // Never close a window from inside its own navigation callback.
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.close();
        }
    });
}

pub fn open(app: &AppHandle, url: &str) -> Result<(), String> {
    let target = validate_sign_in_url(url).ok_or("not a Relo sign-in address")?;
    // A second attempt replaces the first one without reporting it cancelled.
    if let Some(old) = CURRENT.lock().unwrap().take() {
        old.store(true, Ordering::SeqCst);
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    let finished = Arc::new(AtomicBool::new(false));
    *CURRENT.lock().unwrap() = Some(finished.clone());

    let nav_app = app.clone();
    let nav_done = finished.clone();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(target))
        .title("Sign in to Relo")
        .inner_size(480.0, 640.0)
        .min_inner_size(380.0, 480.0)
        .center()
        .focused(true)
        .resizable(true)
        .skip_taskbar(false)
        .always_on_top(false)
        .on_navigation(move |url| match classify_navigation(url) {
            Nav::Allow => {
                eprintln!("relo: sign-in window navigates to {}://{}{}", url.scheme(), url.host_str().unwrap_or(""), url.path());
                true
            }
            Nav::Callback(valid) => {
                if !nav_done.swap(true, Ordering::SeqCst) {
                    os::handle_url(&nav_app, &valid);
                    close_later(&nav_app);
                }
                false
            }
            Nav::Block => {
                eprintln!("relo: sign-in window blocked a navigation to {}", url.scheme());
                false
            }
        })
        .build()
        .map_err(|e| format!("the sign-in window could not open: {e}"))?;

    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if !finished.swap(true, Ordering::SeqCst) {
                let _ = close_app.emit_to("notch", "sign_in_closed", Closed {});
            }
        }
    });
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn open_sign_in_window(app: AppHandle, url: String) -> Result<(), String> {
    let handle = app.clone();
    // Windows are created on the main thread. This command is async so it runs off that thread: a sync command would
    // run ON it and block it while waiting for itself.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(open(&handle, &url));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// The page closes the window when sign-in ended some other way (a callback through the OS, a cancel).
#[tauri::command]
pub fn close_sign_in_window(app: AppHandle) {
    if let Some(done) = CURRENT.lock().unwrap().take() {
        done.store(true, Ordering::SeqCst);
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_servers_sign_in_page_opens() {
        assert!(validate_sign_in_url("https://relo.example.com/mobile/sign-in?state=x&device=windows").is_some());
        assert!(validate_sign_in_url("http://localhost:8180/mobile/sign-in?x=1").is_some());
        assert!(validate_sign_in_url("http://example.com/mobile/sign-in").is_none());
        assert!(validate_sign_in_url("https://relo.example.com/other").is_none());
        assert!(validate_sign_in_url("https://u:p@relo.example.com/mobile/sign-in").is_none());
        assert!(validate_sign_in_url("file:///C:/x/mobile/sign-in").is_none());
        assert!(validate_sign_in_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn the_callback_is_intercepted_and_validated_like_the_os_path() {
        assert_eq!(classify_navigation(&u("https://relo.example.com/sign-in")), Nav::Allow);
        assert_eq!(
            classify_navigation(&u("relo://auth/callback?code=c&state=s")),
            Nav::Callback("relo://auth/callback?code=c&state=s".into())
        );
        assert_eq!(classify_navigation(&u("relo://auth/callback?error=access_denied&state=s")), Nav::Callback("relo://auth/callback?error=access_denied&state=s".into()));
        assert_eq!(classify_navigation(&u("relo://evil/callback")), Nav::Block);
        assert_eq!(classify_navigation(&u("relo://u@auth/callback")), Nav::Block);
        assert_eq!(classify_navigation(&u("file:///C:/Windows/System32/calc.exe")), Nav::Block);
        assert_eq!(classify_navigation(&u("ms-settings:privacy")), Nav::Block);
    }
}
