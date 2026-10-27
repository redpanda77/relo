//! Running programs: the bundled Node with the CLI or the supervisor, `schtasks`, `taskkill`. One trait, so the logic
//! above is tested with a fake that records what it was asked to run.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    /// The exit code; -2 when the command was ended at its timeout; -1 when there was none.
    pub status: i32,
}

pub const TIMED_OUT: i32 = -2;

pub trait Runner: Send + Sync {
    /// Runs `exe args…` to its end (no shell, no window, no input) or kills it at `timeout`.
    fn run(&self, exe: &Path, args: &[String], timeout: Duration) -> Result<Output, String>;
    /// Starts `exe args…` detached and hidden, with `env` added, and returns at once.
    fn spawn_detached(&self, exe: &Path, args: &[String], env: &[(String, String)]) -> Result<(), String>;
}

pub fn no_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = c;
}

pub struct RealRunner;

impl Runner for RealRunner {
    fn run(&self, exe: &Path, args: &[String], timeout: Duration) -> Result<Output, String> {
        let mut c = Command::new(exe);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        no_window(&mut c);
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        // Both pipes drain while the command runs, so a chatty one cannot fill a pipe and hang.
        let mut out = child.stdout.take().ok_or("no stdout")?;
        let mut err = child.stderr.take().ok_or("no stderr")?;
        let t_out = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = out.read_to_end(&mut b);
            String::from_utf8_lossy(&b).into_owned()
        });
        let t_err = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = err.read_to_end(&mut b);
            String::from_utf8_lossy(&b).into_owned()
        });
        let start = Instant::now();
        let status = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(s) => break s.code().unwrap_or(-1),
                None if start.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break TIMED_OUT;
                }
                None => std::thread::sleep(Duration::from_millis(40)),
            }
        };
        Ok(Output { stdout: t_out.join().unwrap_or_default(), stderr: t_err.join().unwrap_or_default(), status })
    }

    fn spawn_detached(&self, exe: &Path, args: &[String], env: &[(String, String)]) -> Result<(), String> {
        let mut c = Command::new(exe);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        for (k, v) in env {
            c.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS: it outlives this app's window and console.
            c.creation_flags(0x0800_0000 | 0x0000_0200 | 0x0000_0008);
        }
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// A recording fake for tests: answers each run from `answer`, remembers every call.
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::Mutex;

    pub type Answer = Box<dyn Fn(&Path, &[String]) -> Result<Output, String> + Send + Sync>;

    pub struct FakeRunner {
        pub calls: Mutex<Vec<(PathBuf, Vec<String>)>>,
        pub spawned: Mutex<Vec<(PathBuf, Vec<String>, Vec<(String, String)>)>>,
        answer: Answer,
    }

    impl FakeRunner {
        pub fn new(answer: impl Fn(&Path, &[String]) -> Result<Output, String> + Send + Sync + 'static) -> FakeRunner {
            FakeRunner { calls: Mutex::new(Vec::new()), spawned: Mutex::new(Vec::new()), answer: Box::new(answer) }
        }
        pub fn ok(stdout: &str) -> Output {
            Output { stdout: stdout.into(), stderr: String::new(), status: 0 }
        }
        pub fn failed(code: i32) -> Output {
            Output { stdout: String::new(), stderr: "boom".into(), status: code }
        }
        pub fn commands(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(exe, args)| format!("{} {}", exe.file_name().unwrap().to_string_lossy(), args.join(" ")))
                .collect()
        }
    }

    impl Runner for FakeRunner {
        fn run(&self, exe: &Path, args: &[String], _t: Duration) -> Result<Output, String> {
            self.calls.lock().unwrap().push((exe.to_path_buf(), args.to_vec()));
            (self.answer)(exe, args)
        }
        fn spawn_detached(&self, exe: &Path, args: &[String], env: &[(String, String)]) -> Result<(), String> {
            self.spawned.lock().unwrap().push((exe.to_path_buf(), args.to_vec(), env.to_vec()));
            Ok(())
        }
    }
}
