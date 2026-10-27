//! Tray icon with state. The menu and tooltip are derived from `TrayState` by pure functions (tested);
//! applying them runs on the main thread (menus must be rebuilt there, as codenotch notes).

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Status {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "offline")]
    Offline,
    #[serde(rename = "signedOut")]
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub status: Status,
    pub needs_you: u32,
    pub running: u32,
    pub paused: bool,
    /// The server signed this PC out: the menu offers "Sign in to Relo again…" (as on the Mac).
    #[serde(default)]
    pub needs_sign_in: bool,
    #[serde(default)]
    pub signing_in: bool,
    /// An update is waiting: its version, and whether it is already downloaded.
    #[serde(default)]
    pub update_version: Option<String>,
    #[serde(default)]
    pub update_ready: bool,
    /// Relo runs on this PC: nothing to sign in to, so the menu says "Starting Relo…" and offers Repair.
    #[serde(default)]
    pub local: bool,
    /// A server address exists (the owner typed one or an install handed it over): Sign in is disabled without it
    /// (the Mac's `originChosen`). Defaults to true so an older page never greys the item out.
    #[serde(default = "yes")]
    pub has_origin: bool,
    /// The title of the first card that needs the owner ("2 need you: Deploy to prod").
    #[serde(default)]
    pub first_title: Option<String>,
    /// The signed-in account, for the status line "Relo · ada@example.com".
    #[serde(default)]
    pub email: Option<String>,
    /// The connection is being (re)established: the status line says "(connecting)".
    #[serde(default)]
    pub connecting: bool,
    /// Local mode: Relo's background server would not start ("Relo couldn't start on this PC" and Try again).
    #[serde(default)]
    pub local_failed: bool,
    /// Whether this build takes updates at all (a signing key is configured); filled in by Rust, not by the page.
    #[serde(skip)]
    pub updates_enabled: bool,
}

fn yes() -> bool {
    true
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            status: Status::Starting,
            needs_you: 0,
            running: 0,
            paused: false,
            needs_sign_in: false,
            signing_in: false,
            update_version: None,
            update_ready: false,
            local: false,
            has_origin: true,
            first_title: None,
            email: None,
            connecting: false,
            local_failed: false,
            updates_enabled: false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Entry {
    /// (id, label, enabled)
    Item(&'static str, String, bool),
    Separator,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Icon {
    Idle,
    Attention,
    Offline,
}

pub fn icon_for(s: &TrayState) -> Icon {
    match s.status {
        Status::Offline | Status::SignedOut => Icon::Offline,
        Status::Live if s.needs_you > 0 => Icon::Attention,
        _ => Icon::Idle,
    }
}

pub fn tooltip(s: &TrayState) -> String {
    let base = match s.status {
        Status::Starting => "Relo: starting".to_string(),
        Status::Offline if s.local => "Relo: not answering".to_string(),
        Status::SignedOut if s.local => "Relo: needs a repair".to_string(),
        Status::Offline => "Relo: offline".to_string(),
        Status::SignedOut => "Relo: signed out".to_string(),
        Status::Live => match (s.needs_you, s.running) {
            (0, 0) => "Relo".to_string(),
            (n, 0) => format!("Relo: {}", needs_phrase(n)),
            (0, r) => format!("Relo: {r} running"),
            (n, r) => format!("Relo: {}, {r} running", needs_phrase(n)),
        },
    };
    if s.paused { format!("{base} (alerts paused)") } else { base }
}

/// "1 needs you" / "3 need you" (the Mac's `needsYouLine`).
fn needs_phrase(n: u32) -> String {
    if n == 1 { "1 needs you".into() } else { format!("{n} need you") }
}

/// The connection is up, being re-established, or lost with the last Now still shown: the Mac's connecting/live/offline.
fn connected(s: &TrayState) -> bool {
    matches!(s.status, Status::Live | Status::Offline) || (s.status == Status::Starting && s.connecting)
}

/// The Mac's `statusLine`: who is connected and how, or how Relo on this PC is doing.
fn status_line(s: &TrayState) -> String {
    if s.local {
        return match s.status {
            Status::Offline => "Relo isn't answering on this PC".into(),
            Status::Starting => "Starting Relo…".into(),
            _ => "Relo on this PC".into(),
        };
    }
    let who = s.email.as_deref().filter(|e| !e.is_empty()).map_or("Relo".to_string(), |e| format!("Relo · {e}"));
    match s.status {
        Status::Offline => format!("{who} (offline)"),
        Status::Starting => format!("{who} (connecting)"),
        _ => who,
    }
}

/// The menu, in the Mac's order (boringNotchApp.swift, ReloMenuItems.swift): the two openers, the connection's lines, Settings,
/// the update lines, then Restart and Quit. The Mac's local menu has no Dashboard, sign-in or sign-out; its remote one has no
/// pause while signed out.
pub fn menu_entries(s: &TrayState) -> Vec<Entry> {
    use Entry::*;
    let mut v = vec![Item("open_notch", "Open in Notch".into(), true), Item("open_home", "Open Relo".into(), true)];
    let pause = |v: &mut Vec<Entry>| {
        if s.paused {
            v.push(Item("resume", "Resume alerts".into(), true));
        } else {
            v.push(Item("pause_1h", "Pause alerts for 1 hour".into(), true));
        }
    };
    let lines = |v: &mut Vec<Entry>| {
        if s.needs_you > 0 {
            let count = needs_phrase(s.needs_you);
            let line = match s.first_title.as_deref().filter(|t| !t.is_empty()) {
                Some(title) => format!("{count}: {title}"),
                None => count,
            };
            v.push(Item("needs_you", line, false));
        }
        if s.running > 0 {
            v.push(Item("running", format!("{} running", s.running), false));
        }
    };
    v.push(Separator);
    if s.local {
        if s.local_failed {
            v.push(Item("header", "Relo couldn't start on this PC".into(), false));
            v.push(Item("retry_start", "Try again".into(), true));
        } else if connected(s) {
            lines(&mut v);
            v.push(Separator);
            pause(&mut v);
            v.push(Separator);
            v.push(Item("status", status_line(s), false));
        } else if s.status == Status::SignedOut && !s.signing_in {
            v.push(Item("header", "Relo needs a quick repair on this PC.".into(), false));
            v.push(Item("repair", "Repair".into(), true));
        } else {
            v.push(Item("header", "Starting Relo…".into(), false));
        }
    } else if connected(s) {
        lines(&mut v);
        v.push(Separator);
        v.push(Item("open_dashboard", "Open Dashboard".into(), s.has_origin));
        pause(&mut v);
        v.push(Separator);
        v.push(Item("status", status_line(s), false));
        v.push(Item("sign_out", "Sign out of Relo".into(), true));
    } else if s.signing_in {
        v.push(Item("signing_in", "Signing in to Relo…".into(), false));
    } else {
        let again = s.needs_sign_in;
        v.push(Item("sign_in", if again { "Sign in to Relo again…" } else { "Sign in to Relo…" }.into(), s.has_origin));
    }
    v.push(Separator);
    v.push(Item("settings", "Settings…".into(), true));
    // The waiting update is shown whether or not the owner chose Later in the notch (the Mac's menu reads `waiting`).
    if let Some(version) = &s.update_version {
        let label = if s.update_ready { format!("Restart to update to {version}") } else { format!("Update to {version}…") };
        v.push(Item("update_install", label, true));
    }
    if s.updates_enabled {
        v.push(Item("check_updates", "Check for Updates…".into(), true));
    }
    v.push(Separator);
    v.push(Item("restart", "Restart Relo".into(), true));
    v.push(Item("quit", "Quit Relo".into(), true));
    v
}

fn image(icon: Icon) -> Image<'static> {
    let bytes: &[u8] = match icon {
        Icon::Idle => include_bytes!("../icons/tray-idle.png"),
        Icon::Attention => include_bytes!("../icons/tray-attention.png"),
        Icon::Offline => include_bytes!("../icons/tray-offline.png"),
    };
    Image::from_bytes(bytes).expect("embedded tray icon")
}

#[derive(Serialize, Clone)]
struct ActionPayload {
    action: String,
}

fn build_menu(app: &AppHandle, s: &TrayState) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mut b = MenuBuilder::new(app);
    let mut items = Vec::new();
    for e in menu_entries(s) {
        if let Entry::Item(id, label, enabled) = e {
            items.push((id, MenuItemBuilder::with_id(id, label).enabled(enabled).build(app)?, false));
        } else {
            items.push(("", MenuItemBuilder::new("").build(app)?, true));
        }
    }
    for (_, item, sep) in &items {
        b = if *sep { b.separator() } else { b.item(item) };
    }
    b.build()
}

/// Create the tray (call once from setup, which runs on the main thread).
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let s = TrayState::default();
    TrayIconBuilder::with_id("main")
        .icon(image(icon_for(&s)))
        .tooltip(tooltip(&s))
        .menu(&build_menu(app, &s)?)
        .on_menu_event(|app, ev| {
            let action = ev.id().as_ref().to_string();
            let _ = app.emit_to("notch", "tray_action", ActionPayload { action: action.clone() });
            // T01/T02: the Mac's "Open in Notch" (the notch listens for `shortcut`) and "Open Relo" (Home window).
            if action == "open_notch" {
                let _ = app.emit_to("notch", "shortcut", ActionPayload { action: "openNotch".into() });
            }
            if action == "open_home" {
                let _ = crate::home_window::open(app);
            }
            if action == "settings" {
                let _ = crate::settings_window::open(app, None);
            }
            if action == "restart" {
                // The Mac's `ApplicationRelauncher.restart()`: start Relo again and leave. (W1's restart command, if it lands, does the
                // same; the tray does not depend on it.)
                app.restart();
            }
            if action == "quit" {
                // The page plays the quit sound first (quit.rs), then Rust exits.
                crate::quit::request(app);
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_tray(app: AppHandle, mut state: TrayState) -> Result<(), String> {
    // "Check for Updates…" is offered only by a build that takes updates (the Mac: `ReloUpdater.shared.started`).
    state.updates_enabled = crate::updater::updater_enabled(app.clone());
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id("main") else { return };
        if let Ok(menu) = build_menu(&handle, &state) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_icon(Some(image(icon_for(&state))));
        let _ = tray.set_tooltip(Some(tooltip(&state)));
    })
    .map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn st(status: Status, n: u32, r: u32, paused: bool) -> TrayState {
        TrayState { status, needs_you: n, running: r, paused, ..TrayState::default() }
    }
    fn live(n: u32, r: u32) -> TrayState {
        st(Status::Live, n, r, false)
    }
    fn on_this_pc(status: Status) -> TrayState {
        TrayState { local: true, ..st(status, 0, 0, false) }
    }
    fn labels(s: &TrayState) -> Vec<String> {
        menu_entries(s)
            .into_iter()
            .filter_map(|e| if let Entry::Item(_, l, _) = e { Some(l) } else { None })
            .collect()
    }
    fn enabled(s: &TrayState, id: &str) -> Option<bool> {
        menu_entries(s).into_iter().find_map(|e| match e {
            Entry::Item(i, _, on) if i == id => Some(on),
            _ => None,
        })
    }

    #[test]
    fn connected_menu_follows_the_mac_order() {
        let s = TrayState { email: Some("ada@example.com".into()), first_title: Some("Deploy to prod".into()), ..live(2, 3) };
        assert_eq!(
            labels(&s),
            ["Open in Notch", "Open Relo", "2 need you: Deploy to prod", "3 running", "Open Dashboard", "Pause alerts for 1 hour", "Relo · ada@example.com", "Sign out of Relo", "Settings…", "Restart Relo", "Quit Relo"]
        );
    }

    #[test]
    fn counts_of_zero_are_hidden_and_one_is_singular() {
        let l = labels(&live(0, 0));
        assert!(!l.iter().any(|x| x.contains("need") || x.contains("running")));
        assert!(labels(&live(1, 0)).contains(&"1 needs you".to_string()));
        assert!(labels(&TrayState { first_title: Some("Ship it".into()), ..live(1, 0) }).contains(&"1 needs you: Ship it".to_string()));
        assert!(labels(&live(0, 4)).contains(&"4 running".to_string()));
        assert_eq!(tooltip(&live(1, 0)), "Relo: 1 needs you");
    }

    #[test]
    fn the_status_line_says_offline_and_connecting() {
        let mut s = TrayState { email: Some("ada@example.com".into()), ..st(Status::Offline, 0, 0, false) };
        assert!(labels(&s).contains(&"Relo · ada@example.com (offline)".to_string()));
        s.status = Status::Starting;
        s.connecting = true;
        assert!(labels(&s).contains(&"Relo · ada@example.com (connecting)".to_string()));
        s.email = None;
        assert!(labels(&s).contains(&"Relo (connecting)".to_string()));
        // Still connected: the last Now is on screen, so Dashboard and Sign out stay.
        assert!(labels(&s).contains(&"Sign out of Relo".to_string()));
    }

    #[test]
    fn sign_in_wording_follows_the_mac_and_waits_for_an_address() {
        let mut s = st(Status::SignedOut, 0, 0, false);
        s.needs_sign_in = true;
        assert!(labels(&s).contains(&"Sign in to Relo again…".to_string()));
        assert_eq!(enabled(&s, "sign_in"), Some(true));
        s.has_origin = false;
        assert_eq!(enabled(&s, "sign_in"), Some(false));
        s.needs_sign_in = false;
        assert!(labels(&s).contains(&"Sign in to Relo…".to_string()));
        s.signing_in = true;
        assert!(labels(&s).contains(&"Signing in to Relo…".to_string()));
        assert_eq!(enabled(&s, "sign_in"), None);
        assert!(!labels(&s).iter().any(|l| l.starts_with("Sign out")));
        // Starting is the same as signed out until the first answer.
        let starting = TrayState { has_origin: false, ..st(Status::Starting, 0, 0, false) };
        assert_eq!(enabled(&starting, "sign_in"), Some(false));
    }

    #[test]
    fn signed_out_has_no_pause_and_dashboard_needs_an_address() {
        assert_eq!(
            labels(&st(Status::SignedOut, 0, 0, true)),
            ["Open in Notch", "Open Relo", "Sign in to Relo…", "Settings…", "Restart Relo", "Quit Relo"]
        );
        assert_eq!(enabled(&TrayState { has_origin: false, ..live(0, 0) }, "open_dashboard"), Some(false));
        assert_eq!(enabled(&live(0, 0), "open_dashboard"), Some(true));
        assert!(labels(&TrayState { paused: true, ..live(0, 0) }).contains(&"Resume alerts".to_string()));
    }

    #[test]
    fn a_waiting_update_has_a_line_and_updates_can_be_checked() {
        let mut s = live(0, 0);
        s.update_version = Some("0.2.0".into());
        assert!(labels(&s).contains(&"Update to 0.2.0…".to_string()));
        s.update_ready = true;
        assert!(labels(&s).contains(&"Restart to update to 0.2.0".to_string()));
        assert!(!labels(&s).contains(&"Check for Updates…".to_string()));
        s.updates_enabled = true;
        let l = labels(&s);
        let settings = l.iter().position(|x| x == "Settings…").unwrap();
        assert_eq!(&l[settings + 1..], ["Restart to update to 0.2.0", "Check for Updates…", "Restart Relo", "Quit Relo"]);
    }

    #[test]
    fn restart_comes_before_quit() {
        let l = labels(&live(0, 0));
        assert_eq!(&l[l.len() - 2..], ["Restart Relo", "Quit Relo"]);
        assert_eq!(enabled(&live(0, 0), "restart"), Some(true));
    }

    #[test]
    fn on_this_pc_the_menu_speaks_the_local_words() {
        assert_eq!(labels(&on_this_pc(Status::Starting)), ["Open in Notch", "Open Relo", "Starting Relo…", "Settings…", "Restart Relo", "Quit Relo"]);
        assert_eq!(
            labels(&on_this_pc(Status::SignedOut)),
            ["Open in Notch", "Open Relo", "Relo needs a quick repair on this PC.", "Repair", "Settings…", "Restart Relo", "Quit Relo"]
        );
        // Relo could not start: its title and Try again.
        let failed = TrayState { local_failed: true, ..on_this_pc(Status::Starting) };
        assert_eq!(labels(&failed), ["Open in Notch", "Open Relo", "Relo couldn't start on this PC", "Try again", "Settings…", "Restart Relo", "Quit Relo"]);
        assert_eq!(enabled(&failed, "retry_start"), Some(true));
        // Connected: counts, pause, and the status line (no Dashboard, no sign-out).
        let running = TrayState { first_title: Some("Build".into()), needs_you: 1, running: 2, ..on_this_pc(Status::Live) };
        assert_eq!(
            labels(&running),
            ["Open in Notch", "Open Relo", "1 needs you: Build", "2 running", "Pause alerts for 1 hour", "Relo on this PC", "Settings…", "Restart Relo", "Quit Relo"]
        );
        assert!(labels(&on_this_pc(Status::Offline)).contains(&"Relo isn't answering on this PC".to_string()));
        // Never a sign-in, whatever the state.
        for status in [Status::Starting, Status::Live, Status::Offline, Status::SignedOut] {
            assert!(labels(&on_this_pc(status)).iter().all(|l| !l.contains("Sign in") && !l.contains("signed") && !l.contains("Dashboard")), "{status:?}");
        }
        assert_eq!(tooltip(&on_this_pc(Status::Offline)), "Relo: not answering");
        assert_eq!(tooltip(&on_this_pc(Status::SignedOut)), "Relo: needs a repair");
    }

    #[test]
    fn icons_and_tooltips() {
        assert_eq!(icon_for(&st(Status::Live, 1, 0, false)), Icon::Attention);
        assert_eq!(icon_for(&st(Status::Live, 0, 4, false)), Icon::Idle);
        assert_eq!(icon_for(&st(Status::Starting, 0, 0, false)), Icon::Idle);
        assert_eq!(icon_for(&st(Status::Offline, 5, 0, false)), Icon::Offline);
        assert_eq!(icon_for(&st(Status::SignedOut, 0, 0, false)), Icon::Offline);
        assert_eq!(tooltip(&st(Status::Live, 2, 1, true)), "Relo: 2 need you, 1 running (alerts paused)");
        assert_eq!(tooltip(&st(Status::Live, 0, 0, false)), "Relo");
        assert_eq!(tooltip(&st(Status::Offline, 0, 0, false)), "Relo: offline");
    }

    #[test]
    fn state_deserialises_from_the_ts_shape() {
        let s: TrayState = serde_json::from_str(r#"{"status":"signedOut","needsYou":2,"running":1,"paused":true}"#).unwrap();
        assert_eq!(s, st(Status::SignedOut, 2, 1, true));
        assert!(s.has_origin, "an older page never greys Sign in out");
        let full: TrayState = serde_json::from_str(
            r#"{"status":"live","needsYou":1,"running":0,"paused":false,"hasOrigin":false,"firstTitle":"Ship it","email":"a@b.c","connecting":true,"localFailed":true,"updatesEnabled":true}"#,
        )
        .unwrap();
        assert!(!full.has_origin && full.connecting && full.local_failed);
        assert_eq!(full.first_title.as_deref(), Some("Ship it"));
        assert_eq!(full.email.as_deref(), Some("a@b.c"));
        assert!(!full.updates_enabled, "Rust decides that, not the page");
        assert!(serde_json::from_str::<TrayState>(r#"{"status":"bogus","needsYou":0,"running":0,"paused":false}"#).is_err());
    }
}
