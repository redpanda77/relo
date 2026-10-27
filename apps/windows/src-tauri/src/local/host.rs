//! Starting and stopping the server: the Windows twin of the Mac's login agent (ReloServerService.swift). Where the
//! payload has `ReloServer.exe` beside it (every installed build), that program is the one implementation of the server's
//! lifecycle: it runs the supervisor, registers and removes the per-user "Relo Server" logon task (with the HKCU Run
//! fallback) and stops the supervisor gracefully over its named pipe. The app never creates tasks itself and ends a
//! process tree only as a logged last resort. A dev build without it runs the bundled Node on the supervisor directly
//! (and stops it with the supervisor's own `stop`). Everything goes through the `ServerHost` trait, so the logic above is
//! tested with a fake.

use super::paths::{Paths, Payload};
use super::runner::{Output, Runner};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub trait ServerHost: Send + Sync {
    /// The server will start at every sign-in from now on (ReloServer.exe's logon task or Run value exists).
    fn ensure_registered(&self) -> Result<(), String>;
    /// The server is set to start at sign-in (the Mac's `.enabled` / `.needsApproval`); a dev build without ReloServer.exe has none.
    fn is_registered(&self) -> bool;
    /// Stops the server and removes it from sign-in.
    fn unregister(&self) -> Result<(), String>;
    /// Makes the server run now; a running one is left alone.
    fn start(&self) -> Result<(), String>;
    /// The old server stops, a new one starts.
    fn restart(&self) -> Result<(), String>;
    /// Stops the server (and its PostgreSQL).
    fn stop(&self) -> Result<(), String>;
    /// The supervisor or its PostgreSQL still has a live process: what must end before the data goes.
    fn has_live_process(&self) -> bool;
}

pub struct WindowsHost {
    pub runner: Arc<dyn Runner>,
    pub payload: Payload,
    pub paths: Paths,
    /// The app's release (the payload's release-identity.txt), handed to the server as RELO_RELEASE_IDENTITY when the app starts it.
    pub release: String,
}

const SHORT: Duration = Duration::from_secs(20);
/// ReloServer.exe `stop` waits up to 90 s for the supervisor to drain and stop PostgreSQL.
const GRACEFUL: Duration = Duration::from_secs(100);

fn s(v: &str) -> String {
    v.to_string()
}

impl WindowsHost {
    fn uses_launcher(&self) -> bool {
        self.payload.has_launcher()
    }

    fn root(&self) -> String {
        self.paths.data_root.display().to_string()
    }

    fn launcher(&self, args: &[&str], timeout: Duration) -> Result<Output, String> {
        self.runner.run(&self.payload.launcher(), &args.iter().map(|a| s(a)).collect::<Vec<_>>(), timeout)
    }

    fn login_registered(&self) -> bool {
        self.launcher(&["login-status"], SHORT).map(|o| o.status == 0).unwrap_or(false)
    }

    /// `ReloServer.exe run` (or Node on the supervisor in a dev build), hidden and detached, the way the logon task runs it.
    fn spawn_supervisor(&self) -> Result<(), String> {
        let env = vec![(s("RELO_RELEASE_IDENTITY"), self.release.clone())];
        if self.uses_launcher() {
            let args = vec![s("run"), s("--root"), self.root(), s("--payload"), self.payload.folder.display().to_string()];
            return self.runner.spawn_detached(&self.payload.launcher(), &args, &env);
        }
        let args = vec![self.payload.supervisor().display().to_string(), s("run"), s("--root"), self.root()];
        self.runner.spawn_detached(&self.payload.node(), &args, &env)
    }

    fn pids(&self) -> Vec<u32> {
        let sup = std::fs::read_to_string(self.paths.supervisor_json()).ok().and_then(|t| pid_from_supervisor_json(&t));
        let pg = std::fs::read_to_string(self.paths.postmaster_pid()).ok().and_then(|t| pid_from_postmaster(&t));
        [sup, pg].into_iter().flatten().collect()
    }

    fn alive(&self, pid: u32) -> bool {
        self.runner
            .run(Path::new("tasklist.exe"), &[s("/FI"), format!("PID eq {pid}"), s("/FO"), s("CSV"), s("/NH")], SHORT)
            .map(|o| tasklist_lists(&o.stdout, pid))
            .unwrap_or(false)
    }

    /// The last resort only: ends the process tree. Logged, because a graceful stop should have made it unnecessary.
    fn kill(&self, pid: u32, force: bool) {
        eprintln!("relo local: ending process {pid}{} after a graceful stop did not finish", if force { " (forced)" } else { "" });
        let mut a = vec![s("/PID"), pid.to_string(), s("/T")];
        if force {
            a.push(s("/F"));
        }
        let _ = self.runner.run(Path::new("taskkill.exe"), &a, SHORT);
    }
}

impl ServerHost for WindowsHost {
    fn is_registered(&self) -> bool {
        self.uses_launcher() && self.login_registered()
    }

    fn ensure_registered(&self) -> Result<(), String> {
        if !self.uses_launcher() || self.login_registered() {
            return Ok(());
        }
        match self.launcher(&["install-login"], SHORT) {
            Ok(o) if o.status == 0 => Ok(()),
            _ => Err(s("Windows would not let Relo run in the background.")),
        }
    }

    fn unregister(&self) -> Result<(), String> {
        let _ = self.stop();
        if self.uses_launcher() {
            match self.launcher(&["uninstall-login"], SHORT) {
                Ok(o) if o.status == 0 => {}
                _ => return Err(s("Windows would not let Relo stop running in the background.")),
            }
        }
        Ok(())
    }

    fn start(&self) -> Result<(), String> {
        self.ensure_registered()?;
        if self.pids().into_iter().any(|p| self.alive(p)) {
            return Ok(());
        }
        self.spawn_supervisor().map_err(|_| s("Windows could not start Relo's background server."))
    }

    fn restart(&self) -> Result<(), String> {
        self.stop()?;
        self.start()
    }

    fn stop(&self) -> Result<(), String> {
        let pids = self.pids();
        if pids.iter().any(|&p| self.alive(p)) {
            // Graceful: the supervisor drains the API and worker and runs `pg_ctl stop -m fast`.
            let root = self.root();
            let asked = if self.uses_launcher() {
                self.launcher(&["stop", "--root", &root], GRACEFUL)
            } else {
                let p = &self.payload;
                self.runner.run(&p.node(), &[p.supervisor().display().to_string(), s("stop"), s("--root"), root], GRACEFUL)
            };
            if let Err(e) = asked {
                eprintln!("relo local: the graceful stop could not run: {e}");
            }
        }
        for _ in 0..20 {
            if !pids.iter().any(|&p| self.alive(p)) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        for &p in &pids {
            if self.alive(p) {
                self.kill(p, false);
            }
        }
        std::thread::sleep(Duration::from_secs(3));
        for &p in &pids {
            if self.alive(p) {
                self.kill(p, true);
            }
        }
        Ok(())
    }

    fn has_live_process(&self) -> bool {
        self.pids().into_iter().any(|p| self.alive(p))
    }
}

/// supervisor.json: `{ "pid": 1234, ... }`.
pub fn pid_from_supervisor_json(text: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.get("pid")?.as_u64().filter(|p| *p > 0 && *p <= u32::MAX as u64).map(|p| p as u32)
}

/// PostgreSQL's postmaster.pid: the process id is its first line.
pub fn pid_from_postmaster(text: &str) -> Option<u32> {
    text.lines().next()?.trim().parse::<u32>().ok().filter(|p| *p > 0)
}

/// `tasklist /FO CSV /NH` prints `"node.exe","1234",...` for a live process and an INFO line when there is none.
pub fn tasklist_lists(output: &str, pid: u32) -> bool {
    output.lines().any(|l| {
        let mut cols = l.split("\",\"");
        cols.next();
        cols.next().map(|c| c.trim_matches('"') == pid.to_string()).unwrap_or(false)
    })
}

/// A recording fake host for tests.
#[cfg(test)]
pub mod fake {
    use super::ServerHost;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeHost {
        pub log: Mutex<Vec<&'static str>>,
        pub live: Mutex<bool>,
        pub fail_register: Mutex<Option<String>>,
        pub registered: Mutex<bool>,
    }

    impl FakeHost {
        pub fn calls(&self) -> Vec<&'static str> {
            self.log.lock().unwrap().clone()
        }
    }

    impl ServerHost for FakeHost {
        fn is_registered(&self) -> bool {
            *self.registered.lock().unwrap()
        }
        fn ensure_registered(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("register");
            match self.fail_register.lock().unwrap().clone() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
        fn unregister(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("unregister");
            Ok(())
        }
        fn start(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("start");
            Ok(())
        }
        fn restart(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("restart");
            Ok(())
        }
        fn stop(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("stop");
            Ok(())
        }
        fn has_live_process(&self) -> bool {
            *self.live.lock().unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::runner::fake::FakeRunner;
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-local-host-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn host(name: &str, with_launcher: bool, runner: Arc<FakeRunner>) -> (WindowsHost, PathBuf) {
        let root = dir(name);
        let payload = root.join("payload");
        std::fs::create_dir_all(&payload).unwrap();
        std::fs::write(payload.join("node.exe"), "x").unwrap();
        if with_launcher {
            std::fs::write(root.join("ReloServer.exe"), "x").unwrap();
        }
        let paths = Paths::new(&root.join("local"), None);
        (WindowsHost { runner, payload: Payload { folder: payload }, paths, release: "0.1.0".into() }, root)
    }

    #[test]
    fn pid_parsers() {
        assert_eq!(pid_from_supervisor_json(r#"{"pid":4321,"port":8187}"#), Some(4321));
        assert_eq!(pid_from_supervisor_json(r#"{"pid":0}"#), None);
        assert_eq!(pid_from_supervisor_json("nope"), None);
        assert_eq!(pid_from_postmaster("2468\nC:/data\n1700000000\n"), Some(2468));
        assert_eq!(pid_from_postmaster("  77 \n"), Some(77));
        assert_eq!(pid_from_postmaster("x\n"), None);
    }

    #[test]
    fn tasklist_output_is_read_per_pid() {
        let live = "\"node.exe\",\"4321\",\"Console\",\"1\",\"52,000 K\"\r\n";
        assert!(tasklist_lists(live, 4321));
        assert!(!tasklist_lists(live, 432));
        assert!(!tasklist_lists("INFO: No tasks are running which match the specified criteria.\r\n", 4321));
        assert!(!tasklist_lists("", 1));
    }

    fn put_pid(h: &WindowsHost, pid: u32) {
        std::fs::create_dir_all(h.paths.supervisor_json().parent().unwrap()).unwrap();
        std::fs::write(h.paths.supervisor_json(), format!("{{\"pid\":{pid}}}")).unwrap();
    }

    fn live_pid(pid: u32) -> String {
        format!("\"node.exe\",\"{pid}\",\"Console\",\"1\",\"1 K\"\r\n")
    }

    #[test]
    fn without_the_launcher_the_app_starts_node_on_the_supervisor() {
        let runner = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::ok("INFO: No tasks"))));
        let (h, _root) = host("direct", false, runner.clone());
        assert!(h.ensure_registered().is_ok());
        h.start().unwrap();
        let spawned = runner.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 1);
        assert!(spawned[0].0.ends_with("node.exe"));
        assert_eq!(spawned[0].1[1], "run");
        assert_eq!(spawned[0].1[2], "--root");
        assert_eq!(spawned[0].2, vec![("RELO_RELEASE_IDENTITY".to_string(), "0.1.0".to_string())]);
        // No ReloServer.exe and no schtasks call: there is no task to manage.
        assert!(runner.commands().iter().all(|c| !c.starts_with("schtasks") && !c.starts_with("ReloServer")));
    }

    #[test]
    fn a_running_supervisor_is_not_started_twice() {
        let runner = Arc::new(FakeRunner::new(|exe, _| {
            if exe.ends_with("tasklist.exe") { Ok(FakeRunner::ok(&live_pid(4321))) } else { Ok(FakeRunner::ok("")) }
        }));
        let (h, _root) = host("running", false, runner.clone());
        put_pid(&h, 4321);
        h.start().unwrap();
        assert!(runner.spawned.lock().unwrap().is_empty());
        assert!(h.has_live_process());
    }

    #[test]
    fn with_the_launcher_it_registers_the_login_once_and_runs_the_server() {
        let runner = Arc::new(FakeRunner::new(|_, args| {
            // Not registered yet: login-status fails, install-login succeeds.
            if args.first().map(String::as_str) == Some("login-status") { Ok(FakeRunner::failed(1)) } else { Ok(FakeRunner::ok("")) }
        }));
        let (h, _root) = host("task", true, runner.clone());
        h.start().unwrap();
        let cmds = runner.commands();
        assert_eq!(cmds[0], "ReloServer.exe login-status");
        assert_eq!(cmds[1], "ReloServer.exe install-login");
        // The app never talks to the Task Scheduler itself.
        assert!(cmds.iter().all(|c| !c.starts_with("schtasks")), "{cmds:?}");
        let spawned = runner.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 1);
        assert!(spawned[0].0.ends_with("ReloServer.exe"));
        assert_eq!(&spawned[0].1[..3], ["run", "--root", &h.root()]);
        assert_eq!(spawned[0].1[3], "--payload");
        assert_eq!(spawned[0].2, vec![("RELO_RELEASE_IDENTITY".to_string(), "0.1.0".to_string())]);
    }

    #[test]
    fn a_registered_login_is_not_registered_again() {
        let runner = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::ok("Task"))));
        let (h, _root) = host("registered", true, runner.clone());
        h.ensure_registered().unwrap();
        assert_eq!(runner.commands(), ["ReloServer.exe login-status"]);
    }

    #[test]
    fn a_login_that_cannot_be_registered_says_so_in_plain_words() {
        let runner = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::failed(1))));
        let (h, _root) = host("denied", true, runner);
        assert_eq!(h.ensure_registered().unwrap_err(), "Windows would not let Relo run in the background.");
    }

    #[test]
    fn stop_asks_the_launcher_and_never_kills_a_server_that_stopped() {
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stopped.clone();
        let runner = Arc::new(FakeRunner::new(move |exe, args| {
            if exe.ends_with("tasklist.exe") {
                return Ok(FakeRunner::ok(if flag.load(std::sync::atomic::Ordering::SeqCst) { "INFO: No tasks" } else { "\"node.exe\",\"4321\",\"C\",\"1\",\"1 K\"\r\n" }));
            }
            if args.first().map(String::as_str) == Some("stop") {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(FakeRunner::ok(""))
        }));
        let (h, _root) = host("stop", true, runner.clone());
        put_pid(&h, 4321);
        h.stop().unwrap();
        let cmds = runner.commands();
        assert!(cmds.iter().any(|c| c.starts_with("ReloServer.exe stop --root")), "{cmds:?}");
        assert!(cmds.iter().all(|c| !c.starts_with("taskkill") && !c.starts_with("schtasks")), "{cmds:?}");
    }

    #[test]
    fn a_dev_stop_uses_the_supervisors_own_stop() {
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stopped.clone();
        let runner = Arc::new(FakeRunner::new(move |exe, args| {
            if exe.ends_with("tasklist.exe") {
                return Ok(FakeRunner::ok(if flag.load(std::sync::atomic::Ordering::SeqCst) { "INFO: none" } else { "\"node.exe\",\"4321\",\"C\",\"1\",\"1 K\"\r\n" }));
            }
            if args.iter().any(|a| a == "stop") {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(FakeRunner::ok(""))
        }));
        let (h, _root) = host("devstop", false, runner.clone());
        put_pid(&h, 4321);
        h.stop().unwrap();
        let cmds = runner.commands();
        assert!(cmds.iter().any(|c| c.starts_with("node.exe") && c.contains("main.js stop --root")), "{cmds:?}");
        assert!(cmds.iter().all(|c| !c.starts_with("taskkill")), "{cmds:?}");
    }

    #[test]
    fn nothing_alive_means_nothing_to_stop() {
        let runner = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::ok("INFO: none"))));
        let (h, _root) = host("idle", true, runner.clone());
        put_pid(&h, 4321);
        h.stop().unwrap();
        assert!(runner.commands().iter().all(|c| c.starts_with("tasklist")));
    }

    #[test]
    fn unregister_stops_then_removes_the_login() {
        let runner = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::ok(""))));
        let (h, _root) = host("unreg", true, runner.clone());
        h.unregister().unwrap();
        assert_eq!(runner.commands(), ["ReloServer.exe uninstall-login"]);
        let denied = Arc::new(FakeRunner::new(|_, _| Ok(FakeRunner::failed(1))));
        let (h2, _r) = host("unreg2", true, denied);
        assert_eq!(h2.unregister().unwrap_err(), "Windows would not let Relo stop running in the background.");
    }
}
