//! Relo for Windows' background server: the pieces `ReloServer.exe` and the app share (the twin of
//! apps/notch/ReloServerLauncher/main.swift). See README.md for the interface.

pub mod login;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW: a child of a console-less program must not open a console of its own.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the bundled server is: `<app dir>\server\` holds node.exe, VERSION and `app\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub dir: PathBuf,
}

impl Payload {
    /// `<app dir>\server`, the app dir being where this executable lives.
    pub fn beside(exe: &Path) -> Payload {
        let app = exe.parent().unwrap_or_else(|| Path::new("."));
        Payload { dir: app.join("server") }
    }
    pub fn node(&self) -> PathBuf {
        self.dir.join("node.exe")
    }
    pub fn main_js(&self) -> PathBuf {
        self.dir.join("app").join("server").join("dist").join("local").join("main.js")
    }
    pub fn postgres_bin(&self) -> PathBuf {
        self.dir.join("app").join("postgres").join("bin")
    }
    /// The release the server records: `RELO_RELEASE_IDENTITY`, else `<payload>\release-identity.txt` (the app's
    /// version, written by the payload build; also read beside the payload), else the server's own VERSION. A different one than config.json holds
    /// makes the supervisor back the database up before migrating.
    pub fn release_identity(&self, env: Option<String>) -> String {
        if let Some(value) = env.filter(|v| !v.trim().is_empty()) {
            return value.trim().to_string();
        }
        let app = self.dir.parent().unwrap_or_else(|| Path::new("."));
        for file in [self.dir.join("release-identity.txt"), app.join("release-identity.txt"), self.dir.join("VERSION")] {
            if let Ok(text) = fs::read_to_string(file) {
                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
        "0".to_string()
    }
    pub fn check(&self) -> Result<(), String> {
        for file in [self.node(), self.main_js()] {
            if !file.is_file() {
                return Err(format!("the bundled server is incomplete: {} is missing", file.display()));
            }
        }
        Ok(())
    }
}

/// `%LOCALAPPDATA%\Relo\server`, the data root the server defaults to.
pub fn default_data_root() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Local")))?;
    Some(base.join("Relo").join("server"))
}

/// The supervisor's stop pipe for a data root: FNV-1a (64-bit) over the lower-cased, normalized path, the same
/// function as `controlPipeName` in apps/server/src/local/layout.ts (both pin the same test vector).
pub fn control_pipe_name(root: &Path) -> String {
    let absolute = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    let mut text = String::new();
    let mut last_separator = false;
    for c in absolute.to_string_lossy().chars() {
        let c = if c == '/' { '\\' } else { c };
        if c == '\\' {
            if last_separator {
                continue;
            }
            last_separator = true;
        } else {
            last_separator = false;
        }
        text.push(c);
    }
    let text = text.trim_end_matches('\\').to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!(r"\\.\pipe\relo-local-{hash:016x}")
}

/// Asks the supervisor on `root` to stop gracefully; false when nothing is listening on its pipe.
pub fn request_stop(root: &Path) -> bool {
    match OpenOptions::new().read(true).write(true).open(control_pipe_name(root)) {
        Ok(mut pipe) => pipe.write_all(b"stop\n").is_ok(),
        Err(_) => false,
    }
}

/// Waits until the supervisor has gone (it removes `run\supervisor.json` last), up to `timeout`.
pub fn wait_stopped(root: &Path, timeout: Duration) -> bool {
    let marker = root.join("run").join("supervisor.json");
    let deadline = Instant::now() + timeout;
    while marker.exists() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    true
}

/// `<root>\logs\relo.log`, appended, created with its folder.
pub fn open_log(root: &Path) -> io::Result<File> {
    let logs = root.join("logs");
    fs::create_dir_all(&logs)?;
    OpenOptions::new().create(true).append(true).open(logs.join("relo.log"))
}

pub struct Running {
    pub child: Child,
    /// Held for the child's lifetime: closing it (also when this process dies) is the supervisor's stop signal.
    pub stdin: Option<ChildStdin>,
}

/// Starts the supervisor: `node main.js run --root <root> --stop-on-stdin-close`, output appended to relo.log.
pub fn start_server(payload: &Payload, root: &Path, port: Option<u16>, identity: &str, log: &File) -> io::Result<Running> {
    let mut command = Command::new(payload.node());
    command
        .arg(payload.main_js())
        .arg("run")
        .arg("--root")
        .arg(root)
        .arg("--stop-on-stdin-close");
    if let Some(port) = port {
        command.arg("--port").arg(port.to_string());
    }
    command
        .env("RELO_POSTGRES_BIN", payload.postgres_bin())
        .env("RELO_RELEASE_IDENTITY", identity)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log.try_clone()?));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    Ok(Running { child, stdin })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_matches_the_server() {
        // Pinned in apps/server/src/local/windows.test.ts too.
        let name = control_pipe_name(Path::new(r"C:\Users\Ana\AppData\Local\Relo\server"));
        if cfg!(windows) {
            assert_eq!(name, r"\\.\pipe\relo-local-560219c1557fd329");
            assert_eq!(control_pipe_name(Path::new(r"c:/users/ana/appdata/local/relo/server/")), name);
        }
        assert_ne!(control_pipe_name(Path::new(r"C:\Users\Ana\Other")), name);
    }

    #[test]
    fn payload_layout_is_beside_the_exe() {
        let payload = Payload::beside(Path::new(r"C:\Program Files\Relo\Relo.exe"));
        assert_eq!(payload.node(), Path::new(r"C:\Program Files\Relo\server").join("node.exe"));
        assert!(payload.main_js().ends_with(Path::new("dist").join("local").join("main.js")));
        assert!(payload.postgres_bin().ends_with(Path::new("postgres").join("bin")));
    }

    #[test]
    fn identity_prefers_env_then_release_file_then_version() {
        let dir = std::env::temp_dir().join(format!("relo-launcher-test-{}", std::process::id()));
        let server = dir.join("server");
        fs::create_dir_all(&server).unwrap();
        let payload = Payload { dir: server.clone() };
        assert_eq!(payload.release_identity(None), "0");
        fs::write(server.join("VERSION"), "0.18.115\n").unwrap();
        assert_eq!(payload.release_identity(None), "0.18.115");
        fs::write(dir.join("release-identity.txt"), "1.2.3+45\n").unwrap();
        assert_eq!(payload.release_identity(Some(" ".into())), "1.2.3+45");
        fs::write(server.join("release-identity.txt"), "2.0.0\n").unwrap();
        assert_eq!(payload.release_identity(None), "2.0.0");
        assert_eq!(payload.release_identity(Some("9.9".into())), "9.9");
        fs::remove_dir_all(dir).unwrap();
    }
}
