//! What local mode does, step by step (ReloLocalMode.swift): the state the windows follow (`local_state`), starting with
//! a restart when the running server is older than the app, linking the app and the relo command to Relo on this PC,
//! and leaving or uninstalling. Pure of Tauri: events leave through a callback, so tests read them.

use super::health::{self, Probe};
use super::invite::{self, Pkce};
use super::launcher::LauncherResult;
use super::server::{LocalServer, FOREIGN_PORT_MESSAGE, SLOW_START_MESSAGE};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Where Relo on this PC stands, as the notch, the tray and Settings show it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Local mode is not on.
    Off,
    Starting,
    Running,
    /// It did not start; `reason` says why. Try again.
    Failed,
    /// Something else answers on Relo's port.
    Foreign,
    /// It was running and stopped answering.
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    /// The owner runs Relo on this PC.
    pub mode: bool,
    /// This build carries the server.
    pub bundled: bool,
    pub phase: Phase,
    pub reason: Option<String>,
    pub port: Option<u16>,
    /// "0.2.32", never the build.
    pub version: Option<String>,
}

impl LocalState {
    pub fn off(bundled: bool) -> LocalState {
        LocalState { mode: false, bundled, phase: Phase::Off, reason: None, port: None, version: None }
    }
}

/// The current state, and the callback that tells the windows when it changes.
pub struct StateCell {
    state: Mutex<LocalState>,
    emit: Box<dyn Fn(&LocalState) + Send + Sync>,
}

impl StateCell {
    pub fn new(initial: LocalState, emit: impl Fn(&LocalState) + Send + Sync + 'static) -> StateCell {
        StateCell { state: Mutex::new(initial), emit: Box::new(emit) }
    }
    pub fn get(&self) -> LocalState {
        self.state.lock().unwrap().clone()
    }
    /// Changes the state and tells the windows, only when it differs.
    pub fn update(&self, f: impl FnOnce(&mut LocalState)) {
        let next = {
            let mut s = self.state.lock().unwrap();
            let before = s.clone();
            f(&mut s);
            (*s != before).then(|| s.clone())
        };
        if let Some(n) = next {
            (self.emit)(&n);
        }
    }
    pub fn starting(&self) {
        self.update(|s| {
            s.phase = Phase::Starting;
            s.reason = None;
        });
    }
    pub fn running(&self, port: u16, release: &str) {
        self.update(|s| {
            s.phase = Phase::Running;
            s.reason = None;
            s.port = Some(port);
            s.version = Some(health::short_version(release).to_string()).filter(|v| !v.is_empty());
        });
    }
    pub fn failed(&self, reason: &str) {
        let foreign = reason == FOREIGN_PORT_MESSAGE;
        self.update(|s| {
            s.phase = if foreign { Phase::Foreign } else { Phase::Failed };
            s.reason = Some(reason.to_string());
        });
    }
}

// ---- The mode file ----

/// `%LOCALAPPDATA%\Relo\local-mode.json`: whether local mode is on, and the release it last started under.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModeFile {
    pub on: bool,
    pub last_release: Option<String>,
}

pub fn read_mode(path: &std::path::Path) -> ModeFile {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or_default()
}

pub fn write_mode(path: &std::path::Path, mode: &ModeFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(mode).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---- Starting ----

/// Registers the server for sign-in, starts it, waits for it, and restarts it when it is an older release (at most
/// `restart_cap`). `on_answering` runs as soon as a server answers, an older one included, so the notch is live while a
/// restart goes on. Returns the words of why it will not run, or None when it runs. Updates `cell` as it goes.
pub fn start(server: &LocalServer, cell: &StateCell, ready_timeout: Duration, restart_cap: Duration, on_answering: &dyn Fn()) -> Option<String> {
    cell.starting();
    if let Err(e) = server.host().ensure_registered() {
        cell.failed(&e);
        return Some(e);
    }
    if matches!(server.probe(), Probe::Silent) {
        if let Err(e) = server.host().start() {
            cell.failed(&e);
            return Some(e);
        }
    }
    let (port, health) = match server.wait_until_ready(ready_timeout) {
        Ok(ready) => ready,
        Err(e) => {
            cell.failed(&e);
            return Some(e);
        }
    };
    on_answering();
    if health.release.is_empty() || !server.needs_restart(&health.release) {
        cell.running(port, &health.release);
        return None;
    }
    // The old server stops, the new one starts: the state stays Starting until the release matches again.
    cell.starting();
    let _ = server.host().restart();
    let deadline = Instant::now() + restart_cap;
    let mut foreign = false;
    let mut delay = 0.5_f64;
    let mut last = None;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs_f64(delay));
        delay = (delay * 1.5).min(2.0);
        match server.probe() {
            Probe::Ours { port, health } => {
                if !server.needs_restart(&health.release) {
                    cell.running(port, &health.release);
                    return None;
                }
                last = Some((port, health));
            }
            Probe::Foreign => foreign = true,
            Probe::Silent => {}
        }
    }
    if foreign {
        cell.failed(FOREIGN_PORT_MESSAGE);
        return Some(FOREIGN_PORT_MESSAGE.to_string());
    }
    // The server answers but reports another release than the app's: it works, so Relo does not stop the owner over it.
    match last {
        Some((port, health)) => {
            cell.running(port, &health.release);
            None
        }
        None => {
            cell.failed(SLOW_START_MESSAGE);
            Some(SLOW_START_MESSAGE.to_string())
        }
    }
}

/// One look at the server while it should be running: the state follows what answers. A failed start stays failed until
/// the owner tries again.
pub fn observe(server: &LocalServer, cell: &StateCell) {
    let now = cell.get();
    if !now.mode || !matches!(now.phase, Phase::Running | Phase::Stopped | Phase::Foreign) {
        return;
    }
    match server.probe() {
        Probe::Ours { port, health } => cell.running(port, &health.release),
        Probe::Foreign => cell.failed(FOREIGN_PORT_MESSAGE),
        Probe::Silent => cell.update(|s| {
            s.phase = Phase::Stopped;
            s.reason = Some("Relo isn't answering on this PC.".into());
        }),
    }
}

// ---- Linking ----

/// What the notch window needs to sign this PC in: no browser, no password. The verifier is the app's own secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub origin: String,
    pub code: String,
    pub verifier: String,
}

/// An invite, the join into the `local` profile (which sets up `agents`, or nothing when `set_up` is false), and the
/// sign-in code for the app. The owner is asked nothing.
pub fn link(server: &LocalServer, agents: &[String], set_up: bool, computer: Option<&str>) -> Result<SignIn, String> {
    let invite = server.invite("guide", agents)?;
    let pkce: Pkce = invite::pkce()?;
    let code = server.join(&invite, &pkce, &invite::client_name(computer), set_up)?;
    Ok(SignIn { origin: invite.api_url, code, verifier: pkce.verifier })
}

// ---- Leaving ----

fn note(problems: &mut Vec<String>, result: Result<(), String>) {
    if let Err(e) = result {
        if !problems.contains(&e) {
            problems.push(e);
        }
    }
}

/// Relo on this PC stops and the app starts over against a server of the owner's. The CLI's `local` profile goes first
/// (it works with the server down), so a failure there changes nothing, unless `ignoring_problems` (an install script
/// that is already signing this PC in elsewhere).
pub fn leave_for_server(server: &LocalServer, mode_path: &std::path::Path, ignoring_problems: bool) -> Option<String> {
    let first = server.logout_local_profile().and_then(|_| server.set_automatic_updates());
    if let Err(e) = first {
        if !ignoring_problems {
            return Some(e);
        }
    }
    let _ = server.host().unregister();
    let _ = write_mode(mode_path, &ModeFile::default());
    None
}

/// Backing out of a setup that did not finish: nothing stays half installed.
pub fn abandon(server: &LocalServer, mode_path: &std::path::Path) {
    let _ = server.logout_local_profile();
    let _ = server.host().unregister();
    let _ = write_mode(mode_path, &ModeFile::default());
}

/// First launch finds the logon task registered but local mode off: a setup that quit half way (the Mac's
/// `cleanUpHalfSetup`, ReloOnboardingSetup.swift:42). The task goes (an orphan server must not keep running) and so does
/// any `local` profile; the owner starts over. Returns whether anything was cleaned.
pub fn clean_up_half_setup(server: &LocalServer, mode_path: &std::path::Path) -> bool {
    if !server.is_bundled() || read_mode(mode_path).on || !server.host().is_registered() {
        return false;
    }
    let _ = server.logout_local_profile();
    let _ = server.host().unregister();
    true
}

/// Removes what Relo set up on this PC, after the owner confirmed it. Returns every problem in words, or None.
pub fn uninstall(server: &LocalServer, mode_path: &std::path::Path, delete_data: bool, stop_wait: Duration) -> Option<String> {
    let mut problems = Vec::new();
    note(&mut problems, server.uninstall_agents());
    note(&mut problems, server.logout_local_profile());
    note(&mut problems, server.set_automatic_updates());
    note(&mut problems, server.host().unregister());
    let stopped = server.wait_until_stopped(stop_wait);
    server.remove_launcher();
    if delete_data {
        if stopped {
            if std::fs::remove_dir_all(&server.paths.data_root).is_err() && server.paths.data_root.exists() {
                note(&mut problems, Err("Relo could not delete its data folder.".into()));
            }
        } else {
            problems.push("Relo is still stopping, so its data was kept. Quit Relo and delete the Relo folder in your Local AppData.".into());
        }
    }
    let _ = write_mode(mode_path, &ModeFile::default());
    (!problems.is_empty()).then(|| problems.join(" "))
}

#[cfg(test)]
mod tests {
    use super::super::host::fake::FakeHost;
    use super::super::paths::{Paths, Payload};
    use super::super::runner::fake::FakeRunner;
    use super::super::runner::Output;
    use super::super::server::HealthFetch;
    use super::health::Health;
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-local-flow-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    struct Rig {
        server: LocalServer,
        runner: Arc<FakeRunner>,
        host: Arc<FakeHost>,
        events: Arc<Mutex<Vec<LocalState>>>,
        cell: StateCell,
        root: PathBuf,
    }

    fn rig(name: &str, answer: impl Fn(&Path, &[String]) -> Result<Output, String> + Send + Sync + 'static, fetch: HealthFetch) -> Rig {
        let root = dir(name);
        let payload = root.join("payload");
        for f in ["node.exe", "cli/bin/relo.mjs", "app/server/dist/local/main.js"] {
            let p = payload.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        let paths = Paths::new(&root.join("local"), None);
        std::fs::create_dir_all(&paths.data_root).unwrap();
        std::fs::write(paths.config(), r#"{"port":8187,"instance":"mine"}"#).unwrap();
        let runner = Arc::new(FakeRunner::new(answer));
        let host = Arc::new(FakeHost::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let cell = StateCell::new(LocalState { mode: true, ..LocalState::off(true) }, move |s| sink.lock().unwrap().push(s.clone()));
        let server = LocalServer::new(Some(Payload { folder: payload }), paths, "0.1.0".into(), runner.clone(), host.clone(), fetch);
        Rig { server, runner, host, events, cell, root }
    }

    fn ok(_: &Path, _: &[String]) -> Result<Output, String> {
        Ok(FakeRunner::ok(""))
    }
    fn answering(instance: &'static str, release: &'static str) -> HealthFetch {
        Box::new(move |_| Some(Health { release: release.into(), instance: instance.into() }))
    }
    fn phases(r: &Rig) -> Vec<Phase> {
        r.events.lock().unwrap().iter().map(|s| s.phase).collect()
    }

    #[test]
    fn a_current_server_goes_starting_then_running() {
        let r = rig("current", ok, answering("mine", "0.1.0"));
        let answered = std::cell::Cell::new(false);
        let problem = start(&r.server, &r.cell, Duration::from_millis(400), Duration::from_secs(1), &|| answered.set(true));
        assert_eq!(problem, None);
        assert!(answered.get());
        assert_eq!(phases(&r), [Phase::Starting, Phase::Running]);
        let s = r.cell.get();
        assert_eq!((s.port, s.version.as_deref()), (Some(8187), Some("0.1.0")));
        // It answers already, so the host is registered but not started again.
        assert_eq!(r.host.calls(), ["register"]);
    }

    #[test]
    fn a_silent_server_is_started_through_the_host() {
        let r = rig("silent", ok, Box::new(|_| None));
        let problem = start(&r.server, &r.cell, Duration::from_millis(400), Duration::from_secs(1), &|| {});
        assert_eq!(problem.as_deref(), Some(SLOW_START_MESSAGE));
        assert_eq!(r.host.calls(), ["register", "start"]);
        assert_eq!(r.cell.get().phase, Phase::Failed);
        assert_eq!(r.cell.get().reason.as_deref(), Some(SLOW_START_MESSAGE));
    }

    #[test]
    fn a_foreign_instance_on_the_port_is_its_own_state() {
        let r = rig("foreign", ok, answering("someone-else", "0.1.0"));
        let problem = start(&r.server, &r.cell, Duration::from_millis(400), Duration::from_secs(1), &|| {});
        assert_eq!(problem.as_deref(), Some(FOREIGN_PORT_MESSAGE));
        assert_eq!(r.cell.get().phase, Phase::Foreign);
    }

    #[test]
    fn a_host_that_cannot_register_fails_with_its_words() {
        let r = rig("noreg", ok, answering("mine", "0.1.0"));
        *r.host.fail_register.lock().unwrap() = Some("Windows would not let Relo run in the background.".into());
        let problem = start(&r.server, &r.cell, Duration::from_millis(400), Duration::from_secs(1), &|| {});
        assert_eq!(problem.as_deref(), Some("Windows would not let Relo run in the background."));
        assert_eq!(r.cell.get().phase, Phase::Failed);
    }

    #[test]
    fn an_older_server_is_restarted_and_followed() {
        // The server answers with the old release first, then the new one after the restart.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = calls.clone();
        let fetch: HealthFetch = Box::new(move |_| {
            let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(Health { release: if n < 2 { "0.0.9".into() } else { "0.1.0".into() }, instance: "mine".into() })
        });
        let r = rig("older", ok, fetch);
        let problem = start(&r.server, &r.cell, Duration::from_secs(2), Duration::from_secs(10), &|| {});
        assert_eq!(problem, None);
        assert!(r.host.calls().contains(&"restart"));
        assert_eq!(r.cell.get().version.as_deref(), Some("0.1.0"));
        assert_eq!(phases(&r), [Phase::Starting, Phase::Running]);
    }

    #[test]
    fn observe_follows_a_running_server_and_leaves_failures_alone() {
        let r = rig("observe", ok, Box::new(|_| None));
        r.cell.running(8187, "0.1.0");
        observe(&r.server, &r.cell);
        assert_eq!(r.cell.get().phase, Phase::Stopped);
        let f = rig("observe2", ok, Box::new(|_| None));
        f.cell.failed("nope");
        observe(&f.server, &f.cell);
        assert_eq!(f.cell.get().reason.as_deref(), Some("nope"));
        assert_eq!(f.cell.get().phase, Phase::Failed);
    }

    #[test]
    fn state_updates_only_emit_changes() {
        let r = rig("emit", ok, Box::new(|_| None));
        r.cell.starting();
        r.cell.starting();
        r.cell.running(1, "1.0+2");
        r.cell.running(1, "1.0+2");
        assert_eq!(phases(&r), [Phase::Starting, Phase::Running]);
    }

    #[test]
    fn linking_returns_the_apps_sign_in_without_asking_anything() {
        let code = format!("relo_signin_{}", "B".repeat(43));
        let r = rig(
            "link",
            move |_, args| {
                if args.iter().any(|a| a == "invite") {
                    Ok(FakeRunner::ok("{\"code\":\"rci_q\",\"apiUrl\":\"http://127.0.0.1:8187\"}"))
                } else {
                    Ok(FakeRunner::ok(&format!("{{\"macAppSignInCode\":\"{code}\"}}")))
                }
            },
            Box::new(|_| None),
        );
        let s = link(&r.server, &["claude-code".into()], true, Some("DESKTOP-1")).unwrap();
        assert_eq!(s.origin, "http://127.0.0.1:8187");
        assert!(s.code.starts_with("relo_signin_"));
        assert!(crate::launch::valid_code_verifier(&s.verifier));
        let join = r.runner.commands().pop().unwrap();
        assert!(join.contains("--client-name DESKTOP-1") && join.contains("--profile local"), "{join}");
        // The challenge sent is the verifier's hash, never the verifier.
        assert!(!join.contains(&s.verifier));
    }

    #[test]
    fn leaving_changes_nothing_when_the_cli_will_not_let_go() {
        let r = rig("leavefail", |_, _| Ok(FakeRunner::failed(1)), Box::new(|_| None));
        let mode = r.root.join("mode.json");
        write_mode(&mode, &ModeFile { on: true, last_release: None }).unwrap();
        assert_eq!(leave_for_server(&r.server, &mode, false).as_deref(), Some("Relo could not leave Relo on this PC."));
        assert!(read_mode(&mode).on);
        assert!(!r.host.calls().contains(&"unregister"));
        // An install script that is already signing in elsewhere leaves regardless.
        assert_eq!(leave_for_server(&r.server, &mode, true), None);
        assert!(!read_mode(&mode).on);
        assert!(r.host.calls().contains(&"unregister"));
    }

    #[test]
    fn a_half_setup_is_cleaned_up_at_the_next_first_launch() {
        let r = rig("half", ok, Box::new(|_| None));
        let mode = r.root.join("mode.json");
        // Local mode off, task registered: cleaned (profile logged out, task removed).
        *r.host.registered.lock().unwrap() = true;
        assert!(clean_up_half_setup(&r.server, &mode));
        assert!(r.host.calls().contains(&"unregister"));
        assert!(r.runner.commands().iter().any(|c| c.ends_with("auth logout --profile local")));
        // Nothing registered: nothing to do.
        let r = rig("half-none", ok, Box::new(|_| None));
        assert!(!clean_up_half_setup(&r.server, &r.root.join("mode.json")));
        assert!(r.host.calls().is_empty());
        // Local mode on: a finished setup is never touched.
        let r = rig("half-on", ok, Box::new(|_| None));
        let mode = r.root.join("mode.json");
        *r.host.registered.lock().unwrap() = true;
        write_mode(&mode, &ModeFile { on: true, last_release: None }).unwrap();
        assert!(!clean_up_half_setup(&r.server, &mode));
        assert!(r.host.calls().is_empty());
    }

    #[test]
    fn uninstall_removes_the_setup_and_the_data_only_on_request() {
        let r = rig("uninstall", ok, Box::new(|_| None));
        let mode = r.root.join("mode.json");
        write_mode(&mode, &ModeFile { on: true, last_release: Some("1".into()) }).unwrap();
        r.server.install_launcher().unwrap();
        assert!(r.server.paths.launcher().exists());
        assert_eq!(uninstall(&r.server, &mode, false, Duration::from_millis(300)), None);
        assert!(!r.server.paths.launcher().exists());
        assert!(r.server.paths.data_root.exists());
        assert!(!read_mode(&mode).on);
        let cmds = r.runner.commands();
        assert!(cmds[0].ends_with("uninstall --apply") && cmds[1].ends_with("auth logout --profile local") && cmds[2].ends_with("update --mode auto"));
        assert_eq!(uninstall(&r.server, &mode, true, Duration::from_millis(300)), None);
        assert!(!r.server.paths.data_root.exists());
    }

    #[test]
    fn uninstall_keeps_the_data_while_the_server_is_still_stopping() {
        let r = rig("stopping", ok, answering("mine", "0.1.0"));
        let mode = r.root.join("mode.json");
        // It still answers for the whole (short) wait in this test only through the host's live flag.
        *r.host.live.lock().unwrap() = true;
        let started = Instant::now();
        let out = uninstall(&r.server, &mode, true, Duration::from_millis(300));
        assert!(started.elapsed() >= Duration::from_millis(290));
        assert!(out.unwrap().contains("data was kept"));
        assert!(r.server.paths.data_root.exists());
    }

    #[test]
    fn the_mode_file_round_trips_and_defaults_off() {
        let p = dir("mode").join("local-mode.json");
        assert_eq!(read_mode(&p), ModeFile::default());
        write_mode(&p, &ModeFile { on: true, last_release: Some("0.1.0".into()) }).unwrap();
        assert_eq!(read_mode(&p), ModeFile { on: true, last_release: Some("0.1.0".into()) });
        std::fs::write(&p, "{ nope").unwrap();
        assert_eq!(read_mode(&p), ModeFile::default());
    }
}
