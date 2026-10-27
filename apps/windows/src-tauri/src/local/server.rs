//! Relo for Windows' local mode: the server, CLI and Node the app carries, run on this PC. This type finds them, asks the
//! server for invites, runs the bundled `relo` command and writes the `relo` launcher in `%LOCALAPPDATA%\Relo\bin`
//! (LocalServer.swift). The process runner, the server host and the health fetch are injected, so everything here is
//! tested without a server.

use super::health::{self, Config, Health, Probe};
use super::host::ServerHost;
use super::invite::{self, Invite, Pkce};
use super::launcher::{self, LauncherResult};
use super::paths::{Paths, Payload};
use super::runner::{Output, Runner, TIMED_OUT};
use crate::settings_window::{parse_agents, Agent};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const FOREIGN_PORT_MESSAGE: &str = "Something on this PC is blocking Relo. Try again.";
pub const SLOW_START_MESSAGE: &str = "Relo is taking longer than usual to start. Try again.";
pub const NOT_BUNDLED_MESSAGE: &str = "This build of Relo does not carry the server.";
pub const NO_CLI_MESSAGE: &str = "This build of Relo does not carry the relo command.";

pub type HealthFetch = Box<dyn Fn(u16) -> Option<Health> + Send + Sync>;

/// Windows 10 version 1809.
pub const MIN_WINDOWS_BUILD: u32 = 17763;

pub struct LocalServer {
    pub payload: Option<Payload>,
    pub paths: Paths,
    /// The app's release: what the running server reports when it is current.
    pub app_release: String,
    runner: Arc<dyn Runner>,
    host: Arc<dyn ServerHost>,
    fetch: HealthFetch,
}

impl LocalServer {
    pub fn new(payload: Option<Payload>, paths: Paths, app_release: String, runner: Arc<dyn Runner>, host: Arc<dyn ServerHost>, fetch: HealthFetch) -> Self {
        LocalServer { payload, paths, app_release, runner, host, fetch }
    }

    pub fn host(&self) -> &Arc<dyn ServerHost> {
        &self.host
    }

    /// Whether this build carries the server (a dev build without RELO_LOCAL_PAYLOAD does not).
    pub fn is_bundled(&self) -> bool {
        self.payload.as_ref().is_some_and(Payload::is_complete)
    }

    fn payload(&self) -> Result<&Payload, String> {
        self.payload.as_ref().filter(|p| p.is_complete()).ok_or_else(|| NOT_BUNDLED_MESSAGE.to_string())
    }

    // ---- Where the app runs ----

    /// Why local setup cannot go ahead here, in words for the owner; None when it can.
    pub fn setup_problem(x64: bool, elevated: bool) -> Option<String> {
        if !x64 {
            return Some("Relo for Windows needs a 64-bit Windows PC with an Intel or AMD processor.".into());
        }
        if elevated {
            return Some("Open Relo without \"Run as administrator\", then try again.".into());
        }
        None
    }

    /// Windows 10 version 1809 (build 17763) is the oldest Windows Relo supports (the installer refuses older ones too).
    /// `build` is None when the version cannot be read, which is not a reason to refuse.
    pub fn os_problem(build: Option<u32>) -> Option<String> {
        match build {
            Some(b) if b < MIN_WINDOWS_BUILD => Some("Relo for Windows needs Windows 10 version 1809 or later, or Windows 11.".into()),
            _ => None,
        }
    }

    // ---- Port and health ----

    pub fn config(&self) -> Option<Config> {
        std::fs::read_to_string(self.paths.config()).ok().and_then(|t| health::parse_config(&t))
    }

    pub fn probe(&self) -> Probe {
        let config = self.config();
        let health = config.as_ref().and_then(|c| (self.fetch)(c.port));
        health::classify(config.as_ref(), health)
    }

    /// Waits for this install's server to answer. The port is read again each time (the supervisor writes it on first
    /// start and picks another when one is taken). A server that is not ours on the port restarts ours once.
    pub fn wait_until_ready(&self, timeout: Duration) -> Result<(u16, Health), String> {
        let deadline = Instant::now() + timeout;
        let (mut foreign, mut restarted) = (false, false);
        let mut delay = 0.2_f64;
        loop {
            match self.probe() {
                Probe::Ours { port, health } => return Ok((port, health)),
                Probe::Foreign => {
                    foreign = true;
                    if !restarted {
                        restarted = true;
                        let _ = self.host.restart();
                    }
                }
                Probe::Silent => {}
            }
            if Instant::now() >= deadline {
                return Err(if foreign { FOREIGN_PORT_MESSAGE } else { SLOW_START_MESSAGE }.to_string());
            }
            std::thread::sleep(Duration::from_secs_f64(delay.min((deadline - Instant::now()).as_secs_f64().max(0.01))));
            delay = (delay * 1.6).min(2.0);
        }
    }

    pub fn needs_restart(&self, running_release: &str) -> bool {
        running_release != self.app_release
    }

    // ---- Running the bundled programs ----

    fn node(&self, args: Vec<String>, timeout: Duration) -> Result<Output, String> {
        let p = self.payload()?;
        self.runner.run(&p.node(), &args, timeout)
    }

    /// Runs the bundled relo command: `relo(["setup", "--path"])`.
    pub fn relo(&self, args: &[&str], timeout: Duration) -> Result<Output, String> {
        let p = self.payload().map_err(|_| NO_CLI_MESSAGE.to_string())?;
        let mut a = vec![p.cli().display().to_string()];
        a.extend(args.iter().map(|s| s.to_string()));
        self.runner.run(&p.node(), &a, timeout)
    }

    fn relo_checked(&self, args: &[&str], timeout: Duration, failure: &str) -> Result<Output, String> {
        let out = self.relo(args, timeout)?;
        if out.status == 0 {
            Ok(out)
        } else {
            Err(failure.to_string())
        }
    }

    // ---- Preparing and inviting ----

    /// First-run work without serving: layout, secrets, database, owner (the supervisor's `prepare`). Skipped while this
    /// install's server already answers (it would be using the database).
    pub fn prepare(&self) -> Result<(), String> {
        let p = self.payload()?;
        if matches!(self.probe(), Probe::Ours { .. }) {
            return Ok(());
        }
        let args = vec![p.supervisor().display().to_string(), "prepare".into(), "--root".into(), self.paths.data_root.display().to_string()];
        let out = self.node(args, Duration::from_secs(300))?;
        if out.status == 0 {
            Ok(())
        } else {
            Err("Relo could not get ready on this PC.".into())
        }
    }

    pub fn invite(&self, level: &str, agents: &[String]) -> Result<Invite, String> {
        let p = self.payload()?;
        let args = invite::invite_args(&p.supervisor().display().to_string(), &self.paths.data_root.display().to_string(), level, agents);
        let out = self.node(args, Duration::from_secs(60))?;
        if out.status != 0 {
            return Err("Relo could not finish setting up.".into());
        }
        invite::parse_invite(&out.stdout).ok_or_else(|| "Relo could not finish setting up.".to_string())
    }

    /// Signs the CLI in to the local server (and sets up the agents the invite named); returns the app's sign-in code.
    pub fn join(&self, invite: &Invite, pkce: &Pkce, client_name: &str, set_up_agents: bool) -> Result<String, String> {
        let p = self.payload()?;
        let args = invite::join_args(&p.cli().display().to_string(), &invite.code, &invite.api_url, &pkce.challenge, client_name, set_up_agents);
        let out = self.node(args, Duration::from_secs(180))?;
        let failure = if set_up_agents { "Relo could not finish setting up." } else { "Relo could not link this PC." };
        if out.status != 0 {
            return Err(failure.into());
        }
        invite::first_string("macAppSignInCode", &out.stdout)
            .filter(|c| invite::valid_app_sign_in_code(c))
            .ok_or_else(|| failure.to_string())
    }

    // ---- The relo command ----

    pub fn install_launcher(&self) -> Result<LauncherResult, String> {
        let p = self.payload().map_err(|_| NO_CLI_MESSAGE.to_string())?;
        launcher::install(&self.paths.bin_dir(), &p.node(), &p.cli())
    }

    /// Points a launcher this app wrote at this copy of the payload; any other `relo` is left alone.
    pub fn refresh_launcher_if_moved(&self) {
        if let Ok(p) = self.payload() {
            if launcher::is_stale(&self.paths.bin_dir(), &p.node(), &p.cli()) {
                let _ = self.install_launcher();
            }
        }
    }

    pub fn remove_launcher(&self) {
        launcher::remove(&self.paths.bin_dir());
    }

    /// Adds `%LOCALAPPDATA%\Relo\bin` to the user Path (the CLI has the registry code).
    pub fn set_up_path(&self) -> Result<(), String> {
        self.relo_checked(&["setup", "--path"], Duration::from_secs(60), "Relo could not add the relo command to your Path.").map(|_| ())
    }

    pub fn set_managed_updates(&self) -> Result<(), String> {
        self.relo_checked(&["update", "--mode", "managed"], Duration::from_secs(60), "Relo could not hand its updates to the app.").map(|_| ())
    }

    /// Hands the CLI's updates back to itself (uninstall, leaving).
    pub fn set_automatic_updates(&self) -> Result<(), String> {
        self.relo_checked(&["update", "--mode", "auto"], Duration::from_secs(60), "Relo could not hand its updates back.").map(|_| ())
    }

    /// Removes the local profile from the CLI (works with the server down); other profiles stay.
    pub fn logout_local_profile(&self) -> Result<(), String> {
        self.relo_checked(&["auth", "logout", "--profile", invite::LOCAL_PROFILE], Duration::from_secs(60), "Relo could not leave Relo on this PC.").map(|_| ())
    }

    /// Refreshes what Relo wrote into the agents; gives up after `timeout`, ending the command.
    pub fn refresh_agents(&self, timeout: Duration) -> Result<(), String> {
        let failure = "Relo could not refresh your agents' setup.";
        match self.relo(&["setup", "--refresh"], timeout) {
            Ok(o) if o.status == 0 => Ok(()),
            Ok(o) if o.status == TIMED_OUT => Err(failure.into()),
            _ => Err(failure.into()),
        }
    }

    /// Raises the test card in the notch ("Can you see this card?"): the command waits only a moment, and the card stays
    /// for the owner to answer. Its exit code (pending, timeout) is not a failure.
    pub fn raise_test_card(&self) -> Result<(), String> {
        self.relo(&["test", "--again", "--timeout", "3s"], Duration::from_secs(30)).map(|_| ())
    }

    pub fn uninstall_agents(&self) -> Result<(), String> {
        self.relo_checked(&["uninstall", "--apply"], Duration::from_secs(120), "Relo could not remove its setup from your agents.").map(|_| ())
    }

    pub fn set_up_agents_args(agents: &[String], computer: &str, level: Option<&str>) -> Vec<String> {
        let mut a: Vec<String> = vec!["setup".into(), "--computer".into(), computer.into(), "--json".into()];
        if let Some(l) = level {
            a.extend(["--level".into(), l.into()]);
        }
        for id in agents {
            a.extend(["--agent".into(), id.clone()]);
        }
        a
    }

    /// Sets up the named agents (`relo setup --agent …`), writing only Relo's own block; no prompt can appear.
    pub fn set_up_agents(&self, agents: &[String], computer: &str, level: &str) -> Result<(), String> {
        if agents.is_empty() {
            return Ok(());
        }
        let p = self.payload().map_err(|_| NO_CLI_MESSAGE.to_string())?;
        let mut a = vec![p.cli().display().to_string()];
        a.extend(Self::set_up_agents_args(agents, computer, Some(level)));
        let out = self.runner.run(&p.node(), &a, Duration::from_secs(240))?;
        if out.status == 0 {
            Ok(())
        } else {
            Err("Relo could not set up your agents.".into())
        }
    }

    /// The agents on this PC, read without changing anything (`relo setup --show --json`); none when the CLI finds none.
    pub fn detect_agents(&self) -> Vec<Agent> {
        match self.relo(&["setup", "--show", "--json"], Duration::from_secs(60)) {
            Ok(o) if o.status == 0 => parse_agents(&o.stdout),
            _ => Vec::new(),
        }
    }

    /// The host of the server a relo command on this PC is already signed in to (not Relo for Windows' own), or None.
    pub fn existing_remote_login_host(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.paths.cli_config()?).ok()?;
        invite::remote_login_host(&text)
    }

    /// Waits for the server to end (after unregister): it no longer answers and its processes are gone, so the data can
    /// be removed. False when `timeout` passed first.
    pub fn wait_until_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if matches!(self.probe(), Probe::Silent) && !self.host.has_live_process() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

}

#[cfg(test)]
mod tests {
    use super::super::runner::fake::FakeRunner;
    use super::*;
    use std::path::PathBuf;

    use super::super::host::fake::FakeHost;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-local-server-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    struct Rig {
        server: LocalServer,
        runner: Arc<FakeRunner>,
        host: Arc<FakeHost>,
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
        let server = LocalServer::new(Some(Payload { folder: payload }), paths, "0.1.0".into(), runner.clone(), host.clone(), fetch);
        Rig { server, runner, host }
    }

    fn silent() -> HealthFetch {
        Box::new(|_| None)
    }
    fn answering(instance: &'static str, release: &'static str) -> HealthFetch {
        Box::new(move |_| Some(Health { release: release.into(), instance: instance.into() }))
    }

    #[test]
    fn an_old_windows_is_named_and_an_unreadable_version_is_not_a_reason() {
        assert!(LocalServer::os_problem(Some(17134)).unwrap().contains("1809"));
        assert!(LocalServer::os_problem(Some(17763)).is_none());
        assert!(LocalServer::os_problem(Some(22631)).is_none());
        assert!(LocalServer::os_problem(None).is_none());
    }

    #[test]
    fn setup_problems_are_in_plain_words() {
        assert!(LocalServer::setup_problem(true, false).is_none());
        assert!(LocalServer::setup_problem(false, false).unwrap().contains("64-bit"));
        assert!(LocalServer::setup_problem(true, true).unwrap().contains("administrator"));
        // Neither mentions an account, a server address, an iPhone or encryption.
        for p in [LocalServer::setup_problem(false, false).unwrap(), LocalServer::setup_problem(true, true).unwrap()] {
            for word in ["account", "server address", "iPhone", "encrypt"] {
                assert!(!p.to_lowercase().contains(&word.to_lowercase()), "{p}");
            }
        }
    }

    #[test]
    fn a_dev_build_without_payload_is_not_bundled() {
        let r = rig("nopayload", |_, _| Ok(FakeRunner::ok("")), silent());
        let bare = LocalServer::new(None, r.server.paths.clone(), "0".into(), r.runner.clone(), r.host.clone(), silent());
        assert!(!bare.is_bundled());
        assert_eq!(bare.invite("guide", &[]).unwrap_err(), NOT_BUNDLED_MESSAGE);
        assert!(r.server.is_bundled());
    }

    #[test]
    fn probe_follows_the_instance_rule() {
        assert!(matches!(rig("p1", |_, _| Ok(FakeRunner::ok("")), answering("mine", "0.1.0")).server.probe(), Probe::Ours { port: 8187, .. }));
        assert_eq!(rig("p2", |_, _| Ok(FakeRunner::ok("")), answering("someone-else", "0.1.0")).server.probe(), Probe::Foreign);
        assert_eq!(rig("p3", |_, _| Ok(FakeRunner::ok("")), silent()).server.probe(), Probe::Silent);
    }

    #[test]
    fn a_foreign_server_restarts_ours_once_then_names_the_blocker() {
        let r = rig("foreign", |_, _| Ok(FakeRunner::ok("")), answering("someone-else", "x"));
        let err = r.server.wait_until_ready(Duration::from_millis(600)).unwrap_err();
        assert_eq!(err, FOREIGN_PORT_MESSAGE);
        assert_eq!(r.host.log.lock().unwrap().iter().filter(|e| **e == "restart").count(), 1);
        let slow = rig("silent", |_, _| Ok(FakeRunner::ok("")), silent());
        assert_eq!(slow.server.wait_until_ready(Duration::from_millis(300)).unwrap_err(), SLOW_START_MESSAGE);
    }

    #[test]
    fn ready_returns_the_port_and_release() {
        let r = rig("ready", |_, _| Ok(FakeRunner::ok("")), answering("mine", "0.0.9"));
        let (port, h) = r.server.wait_until_ready(Duration::from_secs(1)).unwrap();
        assert_eq!((port, h.release.as_str()), (8187, "0.0.9"));
        assert!(r.server.needs_restart("0.0.9"));
        assert!(!r.server.needs_restart("0.1.0"));
    }

    #[test]
    fn invite_then_join_returns_the_apps_sign_in_code() {
        let r = rig(
            "join",
            |_, args| {
                if args.iter().any(|a| a == "invite") {
                    Ok(FakeRunner::ok("{\"code\":\"rci_z\",\"apiUrl\":\"http://127.0.0.1:8187\"}\n"))
                } else if args.iter().any(|a| a == "join") {
                    Ok(FakeRunner::ok(&format!("{{\"macAppSignInCode\":\"relo_signin_{}\"}}\n", "A".repeat(43))))
                } else {
                    Ok(FakeRunner::failed(1))
                }
            },
            silent(),
        );
        let invite = r.server.invite("guide", &["claude-code".into()]).unwrap();
        assert_eq!(invite.code, "rci_z");
        let pkce = invite::pkce_from(&[1u8; 32]);
        let code = r.server.join(&invite, &pkce, "My PC", true).unwrap();
        assert!(code.starts_with("relo_signin_"));
        let cmds = r.runner.commands();
        assert!(cmds[0].contains("invite --root") && cmds[0].contains("--agent claude-code"), "{cmds:?}");
        assert!(cmds[1].contains("auth join rci_z") && cmds[1].contains(&format!("--mac-app-challenge {}", pkce.challenge)));
        assert!(!cmds[1].contains("--no-setup"));
    }

    #[test]
    fn a_join_without_a_valid_code_fails_in_words() {
        let r = rig("badjoin", |_, _| Ok(FakeRunner::ok("{\"macAppSignInCode\":\"short\"}")), silent());
        let invite = Invite { code: "rci_a".into(), api_url: "http://127.0.0.1:8187".into() };
        let pkce = invite::pkce_from(&[2u8; 32]);
        assert_eq!(r.server.join(&invite, &pkce, "PC", true).unwrap_err(), "Relo could not finish setting up.");
        assert_eq!(r.server.join(&invite, &pkce, "PC", false).unwrap_err(), "Relo could not link this PC.");
    }

    #[test]
    fn prepare_is_skipped_while_our_server_answers() {
        let up = rig("prep1", |_, _| Ok(FakeRunner::ok("")), answering("mine", "0.1.0"));
        up.server.prepare().unwrap();
        assert!(up.runner.commands().is_empty());
        let down = rig("prep2", |_, _| Ok(FakeRunner::ok("{\"prepared\":true}")), silent());
        down.server.prepare().unwrap();
        assert!(down.runner.commands()[0].contains("prepare --root"));
        let broken = rig("prep3", |_, _| Ok(FakeRunner::failed(1)), silent());
        assert_eq!(broken.server.prepare().unwrap_err(), "Relo could not get ready on this PC.");
    }

    #[test]
    fn agents_are_detected_and_set_up_with_the_bundled_cli() {
        let r = rig(
            "agents",
            |_, args| {
                if args.iter().any(|a| a == "--show") {
                    Ok(FakeRunner::ok("{\"harnesses\":[{\"harness\":\"codex\"},{\"harness\":\"claude-code\"}]}\n"))
                } else {
                    Ok(FakeRunner::ok(""))
                }
            },
            silent(),
        );
        let ids: Vec<String> = r.server.detect_agents().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["claude-code", "codex"]);
        r.server.set_up_agents(&["codex".into(), "claude-code".into()], "PC", "guide").unwrap();
        let last = r.runner.commands().pop().unwrap();
        assert!(last.contains("setup --computer PC --json --level guide --agent codex --agent claude-code"), "{last}");
        // Nothing chosen, nothing run.
        let before = r.runner.commands().len();
        r.server.set_up_agents(&[], "PC", "guide").unwrap();
        assert_eq!(r.runner.commands().len(), before);
    }

    #[test]
    fn the_launcher_command_points_at_the_bundled_cli() {
        let r = rig("launcher", |_, _| Ok(FakeRunner::ok("")), silent());
        assert_eq!(r.server.install_launcher().unwrap(), LauncherResult::Written);
        let text = std::fs::read_to_string(r.server.paths.launcher()).unwrap();
        assert!(text.contains("Written by Relo for Windows") && text.contains("relo.mjs") && text.contains("node.exe"));
        r.server.remove_launcher();
        assert!(!r.server.paths.launcher().exists());
    }

    #[test]
    fn leaving_commands_use_the_local_profile() {
        let r = rig("leave", |_, _| Ok(FakeRunner::ok("")), silent());
        r.server.logout_local_profile().unwrap();
        r.server.set_automatic_updates().unwrap();
        r.server.set_up_path().unwrap();
        r.server.set_managed_updates().unwrap();
        r.server.uninstall_agents().unwrap();
        r.server.refresh_agents(Duration::from_secs(5)).unwrap();
        let c = r.runner.commands();
        assert!(c[0].ends_with("auth logout --profile local"));
        assert!(c[1].ends_with("update --mode auto"));
        assert!(c[2].ends_with("setup --path"));
        assert!(c[3].ends_with("update --mode managed"));
        assert!(c[4].ends_with("uninstall --apply"));
        assert!(c[5].ends_with("setup --refresh"));
        let bad = rig("leavefail", |_, _| Ok(FakeRunner::failed(1)), silent());
        assert_eq!(bad.server.logout_local_profile().unwrap_err(), "Relo could not leave Relo on this PC.");
    }

    #[test]
    fn wait_until_stopped_needs_silence_and_no_process() {
        let r = rig("stopped", |_, _| Ok(FakeRunner::ok("")), silent());
        assert!(r.server.wait_until_stopped(Duration::from_millis(200)));
        *r.host.live.lock().unwrap() = true;
        assert!(!r.server.wait_until_stopped(Duration::from_millis(200)));
    }
}
