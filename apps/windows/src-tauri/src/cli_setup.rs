//! The `relo` command for an app signed in to a server of the owner's (the onboarding's server route). Run on this PC,
//! Relo for Windows writes the managed launcher itself (local/launcher.rs), puts its folder on the user Path with the
//! CLI's own `setup --path`, and signs the CLI in to the same server and account as the app with a one-time computer
//! invite the signed-in app minted for it (`relo auth join`, apps/server/src/api/computer-invite-routes.ts), so the
//! agents' hooks can report with no terminal and no code to type.
//!
//! Relo for Mac has no remote-server counterpart: its app installs the command only for its own server
//! (LocalServer.swift `installLauncher`, ReloOnboardingSetup.swift `setUpRelo`), and a remote Mac gets its CLI from
//! install.sh. This is the Windows route for a plain download. Everything runs through `Runner`, so the rules are tested
//! without Node, a registry or a server.

use crate::local::invite;
use crate::local::launcher::{self, LauncherResult};
use crate::local::paths::{self, Paths, Payload};
use crate::local::runner::{RealRunner, Runner, TIMED_OUT};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

/// A build without the payload (a dev build) and no relo command on this PC.
pub const NO_COMMAND_MESSAGE: &str = "This copy of Relo does not include the relo command. Install Relo again from your server's download page.";

/// The CLI's switch to leave the registry alone (packages/cli/src/owner/windows-path.mjs); the hermetic tests set it.
pub const NO_REGISTRY_WRITES_ENV: &str = "RELO_NO_REGISTRY_WRITES";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub launcher: LauncherResult,
    /// Set when the owner's own relo command stays in place.
    pub note: Option<String>,
    /// The bin folder is on the user Path (false when it could not be added, or the registry is off limits: hooks name
    /// the command by absolute path, so nothing stops working).
    pub path_ready: bool,
    /// The CLI is already signed in to this server: no code is needed.
    pub signed_in: bool,
}

/// What runs `relo`: relo.cmd when it exists (ours, or another install's), else the bundled Node with the bundled CLI.
pub fn resolve_relo(paths: &Paths, payload: Option<&Payload>) -> Option<(PathBuf, Vec<String>)> {
    let cmd = paths.launcher();
    if cmd.is_file() {
        return Some((cmd, Vec::new()));
    }
    let p = payload.filter(|p| p.has_cli())?;
    Some((p.node(), vec![p.cli().display().to_string()]))
}

fn run_bundled(runner: &dyn Runner, payload: &Payload, args: &[&str], timeout: Duration) -> Result<crate::local::runner::Output, String> {
    let mut a = vec![payload.cli().display().to_string()];
    a.extend(args.iter().map(|s| s.to_string()));
    runner.run(&payload.node(), &a, timeout)
}

/// The active login's server, from the CLI's config: the active profile (or the one flat record of an old file), unless
/// it is a login to Relo on this PC. None without a login.
pub fn active_remote_origin(config_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(config_json.trim_start_matches('\u{feff}')).ok()?;
    let record = match v.get("profiles").and_then(Value::as_object).filter(|p| !p.is_empty()) {
        Some(profiles) => {
            let active = v.get("activeProfile").and_then(Value::as_str).filter(|n| profiles.contains_key(*n));
            let name = match active {
                Some(n) => n.to_string(),
                None => {
                    let mut keys: Vec<&String> = profiles.keys().collect();
                    keys.sort();
                    keys[0].clone()
                }
            };
            profiles.get(&name)?.clone()
        }
        None => v.clone(),
    };
    if record.get("local").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    crate::launch::parse_origin(record.get("apiUrl")?.as_str()?)
}

/// Whether the CLI on this PC is already signed in to `origin`. A login to another server (or to Relo on this PC) is not:
/// a join code switches it, as `relo auth join` does for the install script.
pub fn signed_in_to(paths: &Paths, origin: &str) -> bool {
    let Some(text) = paths.cli_config().and_then(|p| std::fs::read_to_string(p).ok()) else { return false };
    active_remote_origin(&text).as_deref() == Some(origin)
}

/// Makes sure a working `relo` command exists, using the bundled Node and CLI when relo.cmd is missing or is one this app
/// wrote (another relo command is never overwritten), and puts its folder on the user Path unless `registry_writes` is
/// false. A failure to reach the Path is not a failure of the command.
pub fn ensure_command(paths: &Paths, payload: Option<&Payload>, runner: &dyn Runner, registry_writes: bool) -> Result<(LauncherResult, bool), String> {
    let bundled = payload.filter(|p| p.has_cli());
    let launcher = match bundled {
        Some(p) => launcher::install(&paths.bin_dir(), &p.node(), &p.cli()).map_err(|_| "Relo could not add the relo command to this PC.".to_string())?,
        // No payload: only another install's launcher (or one this app wrote earlier) can stand in.
        None if paths.launcher().is_file() => {
            if launcher::is_foreign(&paths.launcher()) { LauncherResult::OtherInstalled } else { LauncherResult::Written }
        }
        None => return Err(NO_COMMAND_MESSAGE.into()),
    };
    let path_ready = registry_writes && add_to_path(paths, payload, runner);
    // Updates of a command this app wrote follow the app; another relo command keeps updating itself (LocalServer.swift).
    if launcher == LauncherResult::Written {
        if let Some(p) = bundled {
            let out = run_bundled(runner, p, &["update", "--mode", "managed"], Duration::from_secs(60))?;
            if out.status != 0 {
                return Err("Relo could not hand its updates to the app.".into());
            }
        }
    }
    Ok((launcher, path_ready))
}

fn add_to_path(paths: &Paths, payload: Option<&Payload>, runner: &dyn Runner) -> bool {
    let Some((exe, mut args)) = resolve_relo(paths, payload) else { return false };
    args.extend(["setup".to_string(), "--path".to_string()]);
    matches!(runner.run(&exe, &args, Duration::from_secs(60)), Ok(o) if o.status == 0)
}

/// `rci_<32>` with the optional `.<22>` bind half the CLI also accepts.
pub fn valid_invite_code(code: &str) -> bool {
    let (main, bind) = match code.split_once('.') {
        Some((m, b)) => (m, Some(b)),
        None => (code, None),
    };
    let word = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    main.strip_prefix("rci_").is_some_and(|r| r.len() == 32 && word(r)) && bind.is_none_or(|b| b.len() == 22 && word(b))
}

/// `relo auth join CODE --api-url ORIGIN --client-name NAME --no-setup`: signs the CLI in to the server as this PC. No
/// profile: like the install script, the code replaces the active login. The agents are set up one by one afterwards.
pub fn join_args(code: &str, origin: &str, client_name: &str) -> Vec<String> {
    ["auth", "join", code, "--api-url", origin, "--client-name", client_name, "--no-setup"].iter().map(|s| s.to_string()).collect()
}

pub fn join(paths: &Paths, payload: Option<&Payload>, runner: &dyn Runner, origin: &str, code: &str, computer: Option<&str>) -> Result<(), String> {
    let origin = crate::launch::parse_origin(origin).ok_or("That is not a server address Relo can use.")?;
    if !valid_invite_code(code) {
        return Err("The server's one-time code did not look right. Try again.".into());
    }
    let (exe, mut args) = resolve_relo(paths, payload).ok_or(NO_COMMAND_MESSAGE)?;
    args.extend(join_args(code, &origin, &invite::client_name(computer)));
    let out = runner.run(&exe, &args, Duration::from_secs(90))?;
    match out.status {
        0 => Ok(()),
        TIMED_OUT => Err("Relo took too long to reach your server. Check your connection and try again.".into()),
        _ => Err("Relo could not sign the relo command in to your server. Try again.".into()),
    }
}

/// What the owner reads when an agent could not be set up: never the CLI's own words, a stack trace or an exit code.
pub fn agent_failure_message(status: i32, agent_name: &str) -> String {
    if status == TIMED_OUT || status == -2 {
        "Relo took too long to set this up. Try again, or skip it for now.".to_string()
    } else {
        format!("Relo could not set up {agent_name}. Try again, or skip it for now.")
    }
}

// ---- Commands ----

fn context() -> Result<(Paths, Option<Payload>), String> {
    let paths = Paths::from_env().ok_or("Relo could not find its folder on this PC.")?;
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let payload = paths::find_payload(std::env::var_os(paths::PAYLOAD_ENV).as_deref(), exe_dir.as_deref());
    Ok((paths, payload))
}

fn registry_writes_allowed() -> bool {
    std::env::var(NO_REGISTRY_WRITES_ENV).map(|v| v != "1").unwrap_or(true)
}

/// Step one of the relo command after a server sign-in: the launcher, the user Path, and whether the CLI is already
/// signed in to `origin`. Err has the words for the owner.
#[tauri::command]
pub async fn cli_prepare(origin: String) -> Result<Prepared, String> {
    let origin = crate::launch::parse_origin(&origin).ok_or("That is not a server address Relo can use.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let (paths, payload) = context()?;
        let (launcher, path_ready) = ensure_command(&paths, payload.as_ref(), &RealRunner, registry_writes_allowed())?;
        let note = (launcher == LauncherResult::OtherInstalled).then(|| launcher::OTHER_LAUNCHER_NOTE.to_string());
        Ok(Prepared { launcher, note, path_ready, signed_in: signed_in_to(&paths, &origin) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Step two: signs the CLI in with the one-time code the signed-in app minted. The code is a bearer secret for one
/// sign-in and is never logged.
#[tauri::command]
pub async fn cli_join(origin: String, code: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (paths, payload) = context()?;
        let computer = std::env::var("COMPUTERNAME").ok();
        join(&paths, payload.as_ref(), &RealRunner, &origin, &code, computer.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::runner::fake::FakeRunner;
    use crate::local::runner::Output;
    use std::path::Path;

    const CODE: &str = "rci_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const BIND: &str = "BBBBBBBBBBBBBBBBBBBBBB";

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-cli-setup-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Paths under a temp folder, and a payload with Node and the CLI (no server needed for the command).
    fn rig(name: &str, with_payload: bool) -> (Paths, Option<Payload>) {
        let root = dir(name);
        let paths = Paths::new(&root.join("local"), Some(root.join("roaming")));
        let folder = root.join("app").join("server");
        std::fs::create_dir_all(folder.join("cli").join("bin")).unwrap();
        if with_payload {
            std::fs::write(folder.join("node.exe"), "x").unwrap();
            std::fs::write(folder.join("cli").join("bin").join("relo.mjs"), "x").unwrap();
        }
        (paths, with_payload.then_some(Payload { folder }))
    }

    fn ok_runner() -> FakeRunner {
        FakeRunner::new(|_, _| Ok(FakeRunner::ok("")))
    }

    #[test]
    fn a_missing_command_is_written_from_the_payload_and_the_path_and_updates_are_set() {
        let (paths, payload) = rig("write", true);
        let runner = ok_runner();
        let (result, path_ready) = ensure_command(&paths, payload.as_ref(), &runner, true).unwrap();
        assert_eq!(result, LauncherResult::Written);
        assert!(path_ready);
        let text = std::fs::read_to_string(paths.launcher()).unwrap();
        assert!(launcher::has_marker(&text));
        assert!(text.contains(&payload.as_ref().unwrap().cli().display().to_string()));
        let calls = runner.commands();
        assert_eq!(calls.len(), 2);
        // The Path goes through the relo command just written; the CLI does the registry work.
        assert!(calls[0].starts_with("relo.cmd setup --path"));
        assert!(calls[1].starts_with("node.exe ") && calls[1].ends_with("update --mode managed"));
    }

    #[test]
    fn the_registry_is_left_alone_when_writes_are_off() {
        let (paths, payload) = rig("noreg", true);
        let runner = ok_runner();
        let (result, path_ready) = ensure_command(&paths, payload.as_ref(), &runner, false).unwrap();
        assert_eq!(result, LauncherResult::Written);
        assert!(!path_ready);
        assert!(runner.commands().iter().all(|c| !c.contains("--path")));
    }

    #[test]
    fn a_path_that_cannot_be_added_does_not_fail_the_command() {
        let (paths, payload) = rig("pathfail", true);
        let runner = FakeRunner::new(|_, args| Ok(if args.iter().any(|a| a == "--path") { FakeRunner::failed(1) } else { FakeRunner::ok("") }));
        let (result, path_ready) = ensure_command(&paths, payload.as_ref(), &runner, true).unwrap();
        assert_eq!((result, path_ready), (LauncherResult::Written, false));
    }

    #[test]
    fn another_relo_command_is_never_overwritten_and_keeps_updating_itself() {
        let (paths, payload) = rig("foreign", true);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        let theirs = "@echo off\r\nrem relo launcher: C:\\x\\relo.mjs\r\n\"C:\\n\\node.exe\" \"C:\\x\\relo.mjs\" %*\r\n";
        std::fs::write(paths.launcher(), theirs).unwrap();
        let runner = ok_runner();
        let (result, path_ready) = ensure_command(&paths, payload.as_ref(), &runner, true).unwrap();
        assert_eq!(result, LauncherResult::OtherInstalled);
        assert!(path_ready);
        assert_eq!(std::fs::read_to_string(paths.launcher()).unwrap(), theirs);
        assert!(runner.commands().iter().all(|c| !c.contains("update")));
    }

    #[test]
    fn without_the_payload_another_command_stands_in_and_otherwise_the_words_say_so() {
        let (paths, none) = rig("nopayload", false);
        assert_eq!(ensure_command(&paths, none.as_ref(), &ok_runner(), true), Err(NO_COMMAND_MESSAGE.to_string()));
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        std::fs::write(paths.launcher(), "@echo off\r\nrem relo launcher: C:\\x\r\n").unwrap();
        let runner = ok_runner();
        assert_eq!(ensure_command(&paths, none.as_ref(), &runner, true).unwrap(), (LauncherResult::OtherInstalled, true));
        // A payload folder without Node or the CLI is no payload for this.
        let (paths, partial) = rig("partial", false);
        let folder = partial.clone().unwrap_or(Payload { folder: paths.relo_root.join("x") });
        assert!(!folder.has_cli());
        assert!(NO_COMMAND_MESSAGE.chars().all(|c| c != '\\'));
    }

    #[test]
    fn a_command_this_app_wrote_that_points_elsewhere_is_rewritten() {
        let (paths, payload) = rig("stale", true);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        std::fs::write(paths.launcher(), launcher::cmd_text(Path::new(r"D:\old\node.exe"), Path::new(r"D:\old\relo.mjs"))).unwrap();
        ensure_command(&paths, payload.as_ref(), &ok_runner(), false).unwrap();
        assert!(!std::fs::read_to_string(paths.launcher()).unwrap().contains("D:\\old"));
    }

    #[test]
    fn relo_runs_through_relo_cmd_or_else_the_bundled_node() {
        let (paths, payload) = rig("resolve", true);
        let (exe, args) = resolve_relo(&paths, payload.as_ref()).unwrap();
        assert_eq!(exe, payload.as_ref().unwrap().node());
        assert_eq!(args, [payload.as_ref().unwrap().cli().display().to_string()]);
        std::fs::create_dir_all(paths.bin_dir()).unwrap();
        std::fs::write(paths.launcher(), "x").unwrap();
        assert_eq!(resolve_relo(&paths, payload.as_ref()), Some((paths.launcher(), vec![])));
        let (bare, none) = rig("resolve-none", false);
        assert_eq!(resolve_relo(&bare, none.as_ref()), None);
    }

    #[test]
    fn the_cli_is_signed_in_to_the_same_server_or_not() {
        let remote = r#"{"activeProfile":"work","profiles":{"work":{"apiUrl":"https://relo.example.com"},"local":{"apiUrl":"http://127.0.0.1:8187","local":true}}}"#;
        assert_eq!(active_remote_origin(remote).as_deref(), Some("https://relo.example.com"));
        let local = r#"{"activeProfile":"local","profiles":{"local":{"apiUrl":"http://127.0.0.1:8187","local":true}}}"#;
        assert_eq!(active_remote_origin(local), None);
        // An old flat record is the default profile.
        assert_eq!(active_remote_origin(r#"{"apiUrl":"https://a.io/","token":"t"}"#).as_deref(), Some("https://a.io"));
        assert_eq!(active_remote_origin("{}"), None);
        assert_eq!(active_remote_origin("not json"), None);

        let (paths, _) = rig("config", false);
        assert!(!signed_in_to(&paths, "https://relo.example.com"));
        let file = paths.cli_config().unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, remote).unwrap();
        assert!(signed_in_to(&paths, "https://relo.example.com"));
        assert!(!signed_in_to(&paths, "https://other.example.com"));
    }

    #[test]
    fn the_join_names_the_server_and_this_pc_and_sets_nothing_up() {
        assert_eq!(
            join_args(CODE, "https://relo.example.com", "MY-PC").join(" "),
            format!("auth join {CODE} --api-url https://relo.example.com --client-name MY-PC --no-setup")
        );
        assert!(valid_invite_code(CODE));
        assert!(valid_invite_code(&format!("{CODE}.{BIND}")));
        for bad in ["", "rci_short", &format!("{CODE}x"), &format!("{CODE}.short"), &format!("{CODE}.{BIND}.x"), "xyz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", &format!("rci_{}!", "A".repeat(31))] {
            assert!(!valid_invite_code(bad), "{bad}");
        }
    }

    #[test]
    fn join_runs_the_command_and_speaks_plainly_when_it_fails() {
        let (paths, payload) = rig("join", true);
        let runner = ok_runner();
        join(&paths, payload.as_ref(), &runner, "https://Relo.example.com/", CODE, Some("MY-PC")).unwrap();
        let calls = runner.commands();
        assert_eq!(calls.len(), 1);
        // No relo.cmd here, so the bundled Node runs the bundled CLI.
        assert!(calls[0].starts_with("node.exe ") && calls[0].ends_with(&format!("auth join {CODE} --api-url https://relo.example.com --client-name MY-PC --no-setup")));

        let failing = FakeRunner::new(|_, _| Ok(FakeRunner::failed(3)));
        let e = join(&paths, payload.as_ref(), &failing, "https://relo.example.com", CODE, None).unwrap_err();
        assert!(e.starts_with("Relo could not sign the relo command in"), "{e}");
        assert!(!e.contains("boom") && !e.contains('3'));
        let slow = FakeRunner::new(|_, _| Ok(Output { status: TIMED_OUT, ..Output::default() }));
        assert!(join(&paths, payload.as_ref(), &slow, "https://relo.example.com", CODE, None).unwrap_err().contains("too long"));
        // Nothing runs for a bad address, a bad code or a PC with no command at all.
        let untouched = ok_runner();
        assert!(join(&paths, payload.as_ref(), &untouched, "http://evil.example.com", CODE, None).is_err());
        assert!(join(&paths, payload.as_ref(), &untouched, "https://relo.example.com", "rci_nope", None).is_err());
        let (bare, none) = rig("join-none", false);
        assert_eq!(join(&bare, none.as_ref(), &untouched, "https://relo.example.com", CODE, None), Err(NO_COMMAND_MESSAGE.to_string()));
        assert!(untouched.commands().is_empty());
    }

    #[test]
    fn an_agent_that_fails_is_told_in_friendly_words() {
        assert_eq!(agent_failure_message(1, "Codex"), "Relo could not set up Codex. Try again, or skip it for now.");
        assert!(agent_failure_message(-2, "Codex").contains("too long"));
        assert!(!agent_failure_message(137, "Codex").contains("137"));
    }
}
