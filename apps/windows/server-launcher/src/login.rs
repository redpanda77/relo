//! Start at login: a per-user Task Scheduler task "Relo Server" that runs ReloServer.exe when this user logs on,
//! never elevated (RunLevel LeastPrivilege, interactive token). Where a task can't be made (a locked-down PC), the
//! per-user Run key does the same job. The Windows twin of the Mac's SMAppService login agent.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Output};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const TASK_NAME: &str = "Relo Server";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginMethod {
    /// A Task Scheduler task.
    Task,
    /// The fallback: a value in HKCU\...\Run.
    RunKey,
}

fn quiet(program: &str, args: &[&str]) -> io::Result<Output> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    command.output()
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The task definition: at this user's logon, as this user with a limited token, no time limit, not stopped on
/// battery, one instance, restarted by the scheduler if it fails to start.
pub fn task_xml(user: &str, exe: &Path) -> String {
    let user = escape_xml(user);
    let exe = escape_xml(&exe.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Runs Relo's server on this PC while you are signed in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command></Exec></Actions>
</Task>
"#
    )
}

/// schtasks reads a task file as UTF-16 with a byte-order mark.
fn utf16_le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn current_user() -> String {
    let name = std::env::var("USERNAME").unwrap_or_default();
    match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() && !name.is_empty() => format!(r"{domain}\{name}"),
        _ => name,
    }
}

/// Registers `exe` to run at logon, as a task named `task` (or in the Run key when no task can be made).
pub fn register_login_named(task: &str, exe: &Path) -> io::Result<LoginMethod> {
    let file = std::env::temp_dir().join(format!("relo-task-{}.xml", std::process::id()));
    fs::write(&file, utf16_le_with_bom(&task_xml(&current_user(), exe)))?;
    let created = quiet("schtasks.exe", &["/Create", "/TN", task, "/XML", &file.to_string_lossy(), "/F"]);
    let _ = fs::remove_file(&file);
    if matches!(&created, Ok(output) if output.status.success()) {
        let _ = quiet("reg.exe", &["delete", RUN_KEY, "/v", task, "/f"]);
        return Ok(LoginMethod::Task);
    }
    let quoted = format!("\"{}\"", exe.display());
    let added = quiet("reg.exe", &["add", RUN_KEY, "/v", task, "/t", "REG_SZ", "/d", &quoted, "/f"])?;
    if added.status.success() {
        Ok(LoginMethod::RunKey)
    } else {
        Err(io::Error::other(String::from_utf8_lossy(&added.stderr).trim().to_string()))
    }
}

/// Removes both forms; true when either was there.
pub fn unregister_login_named(task: &str) -> io::Result<bool> {
    let task_removed = quiet("schtasks.exe", &["/Delete", "/TN", task, "/F"])?.status.success();
    let key_removed = quiet("reg.exe", &["delete", RUN_KEY, "/v", task, "/f"])?.status.success();
    Ok(task_removed || key_removed)
}

pub fn login_status_named(task: &str) -> Option<LoginMethod> {
    if quiet("schtasks.exe", &["/Query", "/TN", task]).map(|o| o.status.success()).unwrap_or(false) {
        return Some(LoginMethod::Task);
    }
    if quiet("reg.exe", &["query", RUN_KEY, "/v", task]).map(|o| o.status.success()).unwrap_or(false) {
        return Some(LoginMethod::RunKey);
    }
    None
}

pub fn register_login(exe: &Path) -> io::Result<LoginMethod> {
    register_login_named(TASK_NAME, exe)
}

pub fn unregister_login() -> io::Result<bool> {
    unregister_login_named(TASK_NAME)
}

pub fn login_status() -> Option<LoginMethod> {
    login_status_named(TASK_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_runs_at_this_users_logon_without_elevation() {
        let xml = task_xml(r"PC\Ana & Co", Path::new(r"C:\Program Files\Relo\ReloServer.exe"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(!xml.contains("HighestAvailable"));
        assert!(xml.contains(r"<UserId>PC\Ana &amp; Co</UserId>"));
        assert!(xml.contains(r"<Command>C:\Program Files\Relo\ReloServer.exe</Command>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    }

    /// Touches the real Task Scheduler (and removes what it made): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn registers_and_removes_a_task_for_real() {
        let name = format!("Relo Server TEST {}", std::process::id());
        let harmless = Path::new(r"C:\Windows\System32\whoami.exe");
        assert_eq!(register_login_named(&name, harmless).unwrap(), LoginMethod::Task);
        assert_eq!(login_status_named(&name), Some(LoginMethod::Task));
        let definition = quiet("schtasks.exe", &["/Query", "/TN", &name, "/XML"]).unwrap();
        let text = String::from_utf8_lossy(&definition.stdout).to_string();
        // LeastPrivilege is the default, so the stored definition just omits it.
        assert!(text.contains("LogonTrigger") && text.contains("InteractiveToken") && !text.contains("HighestAvailable"), "{text}");
        assert!(unregister_login_named(&name).unwrap());
        assert_eq!(login_status_named(&name), None);
    }

    #[test]
    fn the_task_file_is_utf16_with_a_byte_order_mark() {
        let bytes = utf16_le_with_bom("<a>é");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        assert_eq!(bytes.len(), 2 + 2 * 4);
    }
}
