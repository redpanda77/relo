//! Two small services for the page: a Windows toast (notices on a PC whose account has no phone that gets pushes)
//! and a log line in `%LOCALAPPDATA%\Relo\logs\relo-windows.log` (sign-in failures must leave a trace).

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const MAX_LOG_BYTES: u64 = 1_000_000;
const MAX_LINE: usize = 1000;

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

#[tauri::command]
pub fn show_toast(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(clip(&title, 120))
        .body(clip(&body, 240))
        .show()
        .map_err(|e| e.to_string())
}

/// Query values that must never reach a log: the one-time code, the PKCE state and verifier.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    'outer: while !rest.is_empty() {
        for key in ["code=", "state=", "verifier=", "codeVerifier=", "code_challenge=", "token="] {
            if rest.len() >= key.len() && rest[..key.len()].eq_ignore_ascii_case(key) {
                out.push_str(&rest[..key.len()]);
                out.push_str("<redacted>");
                let skip = rest[key.len()..].find(|c: char| matches!(c, '&' | ' ' | '"' | '\'' | '#')).unwrap_or(rest.len() - key.len());
                rest = &rest[key.len() + skip..];
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// `YYYY-MM-DDTHH:MM:SSZ` from epoch seconds (civil-from-days, no time crate).
pub fn iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn log_line(level: &str, message: &str) -> String {
    let level = match level {
        "error" | "warn" | "info" => level,
        _ => "info",
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{} {level} {}\n", iso(now), clip(&redact(message), MAX_LINE))
}

fn log_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(crate::profile::app_dir()).join("logs").join("relo-windows.log"))
}

#[tauri::command]
pub fn log_event(level: String, message: String) {
    let line = log_line(&level, &message);
    eprint!("relo: {line}");
    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_reach_the_log() {
        let out = redact("callback relo://auth/callback?code=relo_signin_AAA&state=abc123 failed; codeVerifier=xyz");
        assert!(!out.contains("relo_signin_AAA") && !out.contains("abc123") && !out.contains("xyz"), "{out}");
        assert!(out.contains("code=<redacted>&state=<redacted> failed"));
    }

    #[test]
    fn lines_are_one_clipped_line_with_a_time() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_800_000_000), "2027-01-15T08:00:00Z");
        let line = log_line("error", &format!("a\nb{}", "x".repeat(5000)));
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        assert!(line.len() < 1100 && line.contains(" error ab"));
        assert!(log_line("bogus", "m").contains(" info "));
    }
}
