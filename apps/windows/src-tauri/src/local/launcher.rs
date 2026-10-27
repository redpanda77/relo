//! The managed `relo` command: `%LOCALAPPDATA%\Relo\bin\relo.cmd` pointing at the CLI inside the payload, with the
//! bundled Node. The CLI recognises the marker line (packages/cli/src/owner/windows-launcher.mjs) and never overwrites
//! such a file; this app never rewrites or removes one without it (LocalServer.swift `installLauncher`).

use serde::Serialize;
use std::path::Path;

/// The line that says Relo for Windows wrote the launcher. Must stay equal to the CLI's WINDOWS_MANAGED_MARKER.
pub const MARKER: &str = "Written by Relo for Windows";

/// What was found at the launcher's path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LauncherResult {
    /// Relo for Windows' launcher is there (new, or rewritten over one it wrote).
    Written,
    /// Another relo command (the install script's, an npm link) is there and was left alone.
    OtherInstalled,
}

/// The words for an owner whose own relo command stays in place.
pub const OTHER_LAUNCHER_NOTE: &str = "Another relo command is installed; Relo for Windows' agents use it.";

/// relo.cmd: names Node and the entry by absolute path, because hooks and services run without the shell's PATH. The
/// `rem relo launcher:` and quoted-command lines are the shape the CLI's parser reads back.
pub fn cmd_text(node: &Path, cli: &Path) -> String {
    format!("@echo off\r\nrem {MARKER}\r\nrem relo launcher: {}\r\n\"{}\" \"{}\" %*\r\n", cli.display(), node.display(), cli.display())
}

/// The sibling for Git Bash, which does not run a bare `relo` as relo.cmd.
pub fn sh_text(node: &Path, cli: &Path) -> String {
    let slash = |p: &Path| p.display().to_string().replace('\\', "/");
    format!("#!/bin/sh\n# {MARKER}\n# relo launcher: {}\nexec \"{}\" \"{}\" \"$@\"\n", slash(cli), slash(node), slash(cli))
}

pub fn has_marker(text: &str) -> bool {
    text.lines().any(|l| l.trim_end_matches('\r').trim_start_matches(['#']).trim_start().trim_start_matches("rem ").trim() == MARKER)
}

/// Whether a launcher at `path` is not Relo for Windows': present, and without the marker.
pub fn is_foreign(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(text) => !has_marker(&text),
        // Present but unreadable (a directory, a dangling link) is not ours to replace unless it is plainly missing.
        Err(e) => e.kind() != std::io::ErrorKind::NotFound && path.symlink_metadata().is_ok(),
    }
}

/// Writes the launcher (and the Git Bash sibling) unless another relo command is there.
pub fn install(bin_dir: &Path, node: &Path, cli: &Path) -> Result<LauncherResult, String> {
    let cmd = bin_dir.join("relo.cmd");
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    if is_foreign(&cmd) {
        return Ok(LauncherResult::OtherInstalled);
    }
    write_atomic(&cmd, &cmd_text(node, cli))?;
    let sh = bin_dir.join("relo");
    if !is_foreign(&sh) {
        write_atomic(&sh, &sh_text(node, cli))?;
    }
    Ok(LauncherResult::Written)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // The launcher may be running right now; Windows refuses a rename over a file in use, so try a few times.
    let mut last = String::new();
    for _ in 0..10 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(last)
}

/// A launcher this app wrote that names another copy of the payload than this one (the app moved or updated).
pub fn is_stale(bin_dir: &Path, node: &Path, cli: &Path) -> bool {
    match std::fs::read_to_string(bin_dir.join("relo.cmd")) {
        Ok(text) => has_marker(&text) && text != cmd_text(node, cli),
        Err(_) => false,
    }
}

/// Removes the launcher only when this app wrote it: another install's `relo` stays.
pub fn remove(bin_dir: &Path) {
    for name in ["relo.cmd", "relo"] {
        let p = bin_dir.join(name);
        if std::fs::read_to_string(&p).map(|t| has_marker(&t)).unwrap_or(false) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("relo-local-launcher-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    const NODE: &str = r"C:\Program Files\Relo\server\node.exe";
    const CLI: &str = r"C:\Program Files\Relo\server\cli\bin\relo.mjs";

    #[test]
    fn cmd_text_is_what_the_cli_parses_back() {
        let t = cmd_text(Path::new(NODE), Path::new(CLI));
        assert!(t.contains("rem Written by Relo for Windows\r\n"));
        // The two lines packages/cli/src/owner/windows-launcher.mjs parseCmdLauncher reads.
        assert!(t.contains(&format!("\r\nrem relo launcher: {CLI}\r\n")));
        assert!(t.ends_with(&format!("\"{NODE}\" \"{CLI}\" %*\r\n")));
        assert!(t.starts_with("@echo off\r\n"));
        assert!(has_marker(&t));
    }

    #[test]
    fn sh_text_uses_forward_slashes() {
        let t = sh_text(Path::new(NODE), Path::new(CLI));
        assert!(t.contains("exec \"C:/Program Files/Relo/server/node.exe\" \"C:/Program Files/Relo/server/cli/bin/relo.mjs\" \"$@\""));
        assert!(has_marker(&t));
    }

    #[test]
    fn marker_must_be_its_own_line() {
        assert!(has_marker("@echo off\r\nrem Written by Relo for Windows\r\n"));
        assert!(has_marker("#!/bin/sh\n# Written by Relo for Windows\n"));
        assert!(!has_marker("@echo off\r\nrem relo launcher: x Written by Relo for Windows\r\n"));
        assert!(!has_marker("@echo off\r\n\"node\" \"relo.mjs\" %*\r\n"));
    }

    #[test]
    fn writes_new_rewrites_ours_and_leaves_foreign_alone() {
        let bin = dir("install");
        assert_eq!(install(&bin, Path::new(NODE), Path::new(CLI)).unwrap(), LauncherResult::Written);
        assert!(std::fs::read_to_string(bin.join("relo.cmd")).unwrap().contains(MARKER));
        assert!(bin.join("relo").is_file());
        // The app moved: ours is stale and is rewritten.
        let moved = Path::new(r"D:\Relo\server\cli\bin\relo.mjs");
        assert!(is_stale(&bin, Path::new(NODE), moved));
        assert!(!is_stale(&bin, Path::new(NODE), Path::new(CLI)));
        assert_eq!(install(&bin, Path::new(NODE), moved).unwrap(), LauncherResult::Written);
        assert!(std::fs::read_to_string(bin.join("relo.cmd")).unwrap().contains("D:\\Relo"));

        // The install script's launcher (no marker) is the owner's: never touched, never removed.
        let other = dir("foreign");
        let theirs = "@echo off\r\nrem relo launcher: C:\\x\\relo.mjs\r\n\"C:\\n\\node.exe\" \"C:\\x\\relo.mjs\" %*\r\n";
        std::fs::write(other.join("relo.cmd"), theirs).unwrap();
        assert_eq!(install(&other, Path::new(NODE), Path::new(CLI)).unwrap(), LauncherResult::OtherInstalled);
        assert_eq!(std::fs::read_to_string(other.join("relo.cmd")).unwrap(), theirs);
        assert!(!is_stale(&other, Path::new(NODE), Path::new(CLI)));
        remove(&other);
        assert!(other.join("relo.cmd").exists());
        remove(&bin);
        assert!(!bin.join("relo.cmd").exists() && !bin.join("relo").exists());
    }
}
