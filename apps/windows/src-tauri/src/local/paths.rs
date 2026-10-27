//! Where things are: the bundled payload (the server, Node and the CLI the app carries), the data root, the logs and the
//! `relo` launcher. Environment and folders are passed in, so tests never touch the real ones.

use std::path::{Path, PathBuf};

/// Dev builds carry no payload; this points at a folder laid out like `<exe dir>\server\`.
pub const PAYLOAD_ENV: &str = "RELO_LOCAL_PAYLOAD";

/// The files of a payload (the Windows twin of the Mac's `Contents/Resources/server`). Node may sit beside the server or
/// in its own `node` folder; both are accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub folder: PathBuf,
}

impl Payload {
    pub fn node(&self) -> PathBuf {
        let beside = self.folder.join("node.exe");
        if beside.is_file() {
            beside
        } else {
            self.folder.join("node").join("node.exe")
        }
    }
    pub fn cli(&self) -> PathBuf {
        self.folder.join("cli").join("bin").join("relo.mjs")
    }
    pub fn supervisor(&self) -> PathBuf {
        self.folder.join("app").join("server").join("dist").join("local").join("main.js")
    }
    /// ReloServer.exe sits beside the payload folder (the Tauri sidecar lands next to the app: `<app dir>\ReloServer.exe`
    /// and `<app dir>\server\`); absent in a dev build without one, where the app starts Node itself.
    pub fn launcher(&self) -> PathBuf {
        self.folder.parent().unwrap_or(&self.folder).join("ReloServer.exe")
    }
    /// The app's release the payload build wrote (`release-identity.txt`, in the payload; else beside it, where the
    /// installer may put it): the one value the app compares the server's reported release with, and that ReloServer.exe
    /// hands the server. None when the payload names none.
    pub fn release_identity(&self) -> Option<String> {
        [self.folder.join("release-identity.txt"), self.folder.parent()?.join("release-identity.txt")]
            .iter()
            .filter_map(|f| std::fs::read_to_string(f).ok())
            .map(|t| t.trim().to_string())
            .find(|t| !t.is_empty())
    }
    pub fn has_launcher(&self) -> bool {
        self.launcher().is_file()
    }
    /// Whether this folder carries Node and the CLI: enough for the `relo` command (a server of the owner's needs no more).
    pub fn has_cli(&self) -> bool {
        self.node().is_file() && self.cli().is_file()
    }
    /// Whether this folder carries the server, the CLI and Node.
    pub fn is_complete(&self) -> bool {
        self.node().is_file() && self.cli().is_file() && self.supervisor().is_file()
    }
}

/// The payload: `RELO_LOCAL_PAYLOAD` when it names a folder (dev), else `<exe dir>\server`. None when neither exists.
pub fn find_payload(env_value: Option<&std::ffi::OsStr>, exe_dir: Option<&Path>) -> Option<Payload> {
    if let Some(value) = env_value.filter(|v| !v.is_empty()) {
        let folder = PathBuf::from(value);
        if folder.is_dir() {
            return Some(Payload { folder });
        }
    }
    let folder = exe_dir?.join("server");
    folder.is_dir().then_some(Payload { folder })
}

/// Everything under `%LOCALAPPDATA%\Relo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// `%LOCALAPPDATA%\Relo`
    pub relo_root: PathBuf,
    /// `%LOCALAPPDATA%\Relo\server`: the server's data root (database, secrets, logs, config.json).
    pub data_root: PathBuf,
    /// `%APPDATA%` (where the CLI keeps `relo\config.json`).
    pub roaming: Option<PathBuf>,
    /// The app's own state: `%LOCALAPPDATA%\Relo`, or `%LOCALAPPDATA%\Relo.dev` in a dev build, so a dev build does not
    /// read the installed app's record that local mode is on. The CLI's `bin` and the server's data root stay under `Relo`.
    pub state_root: PathBuf,
}

impl Paths {
    pub fn new(local_app_data: &Path, roaming: Option<PathBuf>) -> Paths {
        Paths::new_for(local_app_data, roaming, false)
    }
    pub fn new_for(local_app_data: &Path, roaming: Option<PathBuf>, dev: bool) -> Paths {
        let relo_root = local_app_data.join("Relo");
        Paths { data_root: relo_root.join("server"), state_root: local_app_data.join(crate::profile::app_dir_for(dev)), relo_root, roaming }
    }
    pub fn from_env() -> Option<Paths> {
        let local = std::env::var_os("LOCALAPPDATA")?;
        Some(Paths::new_for(Path::new(&local), std::env::var_os("APPDATA").map(PathBuf::from), crate::profile::DEV))
    }
    pub fn logs(&self) -> PathBuf {
        self.data_root.join("logs")
    }
    pub fn config(&self) -> PathBuf {
        self.data_root.join("config.json")
    }
    pub fn supervisor_json(&self) -> PathBuf {
        self.data_root.join("run").join("supervisor.json")
    }
    pub fn postmaster_pid(&self) -> PathBuf {
        self.data_root.join("db").join("postmaster.pid")
    }
    pub fn bin_dir(&self) -> PathBuf {
        self.relo_root.join("bin")
    }
    pub fn launcher(&self) -> PathBuf {
        self.bin_dir().join("relo.cmd")
    }
    /// The Git Bash sibling the CLI writes next to relo.cmd; removed with it.
    pub fn launcher_sh(&self) -> PathBuf {
        self.bin_dir().join("relo")
    }
    /// The app's own record that local mode is on (and the release it last ran).
    pub fn mode_file(&self) -> PathBuf {
        self.state_root.join("local-mode.json")
    }
    /// The CLI's config (`%APPDATA%\relo\config.json`): profiles, to name a server this PC is already signed in to.
    pub fn cli_config(&self) -> Option<PathBuf> {
        self.roaming.as_ref().map(|r| r.join("relo").join("config.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-local-paths-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn env_var_wins_over_the_exe_folder() {
        let dev = dir("dev");
        let exe = dir("exe");
        std::fs::create_dir_all(exe.join("server")).unwrap();
        let p = find_payload(Some(dev.as_os_str()), Some(&exe)).unwrap();
        assert_eq!(p.folder, dev);
        let p = find_payload(None, Some(&exe)).unwrap();
        assert_eq!(p.folder, exe.join("server"));
        // A variable that names nothing falls back to the install.
        let missing = dev.join("nope");
        assert_eq!(find_payload(Some(missing.as_os_str()), Some(&exe)).unwrap().folder, exe.join("server"));
    }

    #[test]
    fn no_payload_when_nothing_is_there() {
        let exe = dir("bare");
        assert_eq!(find_payload(None, Some(&exe)), None);
        assert_eq!(find_payload(Some(std::ffi::OsStr::new("")), None), None);
    }

    #[test]
    fn complete_needs_node_cli_and_supervisor() {
        let f = dir("complete").join("server");
        let p = Payload { folder: f.clone() };
        assert!(!p.is_complete());
        touch(&f.join("node.exe"));
        touch(&p.cli());
        assert!(!p.is_complete());
        touch(&p.supervisor());
        assert!(p.is_complete());
        assert!(!p.has_launcher());
        touch(&p.launcher());
        assert!(p.has_launcher());
        assert_eq!(p.launcher(), f.parent().unwrap().join("ReloServer.exe"));
    }

    #[test]
    fn release_identity_comes_from_the_payload() {
        let f = dir("identity").join("server");
        std::fs::create_dir_all(&f).unwrap();
        let p = Payload { folder: f.clone() };
        assert_eq!(p.release_identity(), None);
        std::fs::write(f.parent().unwrap().join("release-identity.txt"), "0.9.0\n").unwrap();
        assert_eq!(p.release_identity().as_deref(), Some("0.9.0"));
        std::fs::write(f.join("release-identity.txt"), "1.2.3+45\r\n").unwrap();
        assert_eq!(p.release_identity().as_deref(), Some("1.2.3+45"));
    }

    #[test]
    fn node_may_live_in_its_own_folder() {
        let f = dir("nodefolder");
        let p = Payload { folder: f.clone() };
        touch(&f.join("node").join("node.exe"));
        assert_eq!(p.node(), f.join("node").join("node.exe"));
    }

    #[test]
    fn data_lives_under_local_app_data() {
        let p = Paths::new(Path::new(r"C:\Users\a\AppData\Local"), Some(PathBuf::from(r"C:\Users\a\AppData\Roaming")));
        assert_eq!(p.data_root, Path::new(r"C:\Users\a\AppData\Local").join("Relo").join("server"));
        assert_eq!(p.launcher(), Path::new(r"C:\Users\a\AppData\Local").join("Relo").join("bin").join("relo.cmd"));
        assert!(p.logs().ends_with("logs"));
        assert_eq!(p.mode_file(), Path::new(r"C:\Users\a\AppData\Local").join("Relo").join("local-mode.json"));
    }

    #[test]
    fn a_dev_build_keeps_its_own_state_but_the_clis_paths() {
        let local = Path::new(r"C:\Users\a\AppData\Local");
        let dev = Paths::new_for(local, None, true);
        let installed = Paths::new_for(local, None, false);
        assert_eq!(dev.mode_file(), local.join("Relo.dev").join("local-mode.json"));
        assert_ne!(dev.mode_file(), installed.mode_file());
        // The launcher and the server's data belong to the CLI and the server: the same in both.
        assert_eq!(dev.launcher(), installed.launcher());
        assert_eq!(dev.launcher(), local.join("Relo").join("bin").join("relo.cmd"));
        assert_eq!(dev.data_root, installed.data_root);
    }

    #[test]
    fn the_clis_config_is_under_roaming() {
        let p = Paths::new(Path::new(r"C:\Users\a\AppData\Local"), Some(PathBuf::from(r"C:\Users\a\AppData\Roaming")));
        assert!(p.cli_config().unwrap().ends_with(Path::new("relo").join("config.json")));
    }
}
