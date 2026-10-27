//! Pure validation for everything that arrives from outside the process: installer launch arguments
//! (mirrors apps/notch InstallerLaunch.swift), `relo://auth/callback` deep links and `open_url` targets.

use serde::Serialize;
use url::{Host, Url};

const MAX_URL_LEN: usize = 4096;

/// What the install script hands the app when it opens it. `origin` is required; the code and verifier
/// are independently optional (dropped when malformed), as on the Mac.
#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub origin: String,
    pub sign_in_code: Option<String>,
    pub code_verifier: Option<String>,
}

fn is_local_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => *d == "localhost" || d.ends_with(".local"),
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Host::Ipv6(ip) => {
            let s = ip.segments()[0];
            ip.is_loopback() || (s & 0xffc0) == 0xfe80 || (s & 0xfe00) == 0xfc00
        }
    }
}

/// https anywhere, http only for local/private hosts (same policy as ServerEndpointPolicy). Returns the
/// bare origin (no path, query or credentials).
pub fn parse_origin(s: &str) -> Option<String> {
    if s.len() > MAX_URL_LEN {
        return None;
    }
    let u = Url::parse(s).ok()?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    if u.path() != "/" && !u.path().is_empty() {
        return None;
    }
    let host = u.host()?;
    match u.scheme() {
        "https" => {}
        "http" if is_local_host(&host) => {}
        _ => return None,
    }
    Some(u.origin().ascii_serialization())
}

fn in_set(s: &str, extra: &[char]) -> bool {
    s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// `^relo_signin_[A-Za-z0-9_-]{43}$`
pub fn valid_sign_in_code(s: &str) -> bool {
    s.strip_prefix("relo_signin_").is_some_and(|r| r.len() == 43 && in_set(r, &['_', '-']))
}

/// `^[A-Za-z0-9._~-]{43,128}$`
pub fn valid_code_verifier(s: &str) -> bool {
    (43..=128).contains(&s.len()) && in_set(s, &['.', '_', '~', '-'])
}

/// What `launch_args` tells the page: whether Windows started the app at sign-in (`--at-login`, the Run entry's argument),
/// and the installer hand-off when there is one.
#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub at_login: bool,
    #[serde(flatten)]
    pub hand_off: Option<LaunchArgs>,
}

/// `--at-login` among the arguments after the program name.
pub fn started_at_login(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == crate::autostart::AT_LOGIN_FLAG)
}

pub fn parse_launch(args: &[String]) -> Launch {
    Launch { at_login: started_at_login(args), hand_off: parse_launch_args(args) }
}

/// An argument that is a `relo://` link (scheme compared case-insensitively; "relo://" is 7 bytes).
pub fn is_relo_link(a: &str) -> bool {
    a.len() > 7 && a.is_char_boundary(7) && a[..7].eq_ignore_ascii_case("relo://")
}

/// A second launch is a "re-open" (Mac: `applicationShouldHandleReopen`, a Dock click or Finder open) unless it carries
/// something else to deliver: a `relo://` link, an installer hand-off, or Windows' own `--at-login` start.
pub fn is_reopen(args: &[String]) -> bool {
    let has_link = args.iter().skip(1).any(|a| is_relo_link(a));
    !(has_link || started_at_login(args) || args.iter().skip(1).any(|a| a.starts_with("--relo-")))
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).map(String::as_str)
}

/// None unless `--relo-origin` is a valid server origin.
pub fn parse_launch_args(args: &[String]) -> Option<LaunchArgs> {
    let origin = parse_origin(flag_value(args, "--relo-origin")?)?;
    Some(LaunchArgs {
        origin,
        sign_in_code: flag_value(args, "--relo-sign-in-code").filter(|v| valid_sign_in_code(v)).map(String::from),
        code_verifier: flag_value(args, "--relo-code-verifier").filter(|v| valid_code_verifier(v)).map(String::from),
    })
}

/// The installer's own record of where it was downloaded from: `%LOCALAPPDATA%\Relo\install-source.json`,
/// `{"origin":"https://host[:port]"}` (written from the download's Mark-of-the-Web). The Mac has no counterpart: its
/// install script hands the origin over only as `--relo-origin` (InstallerLaunch.swift).
pub const INSTALL_SOURCE_FILE: &str = "install-source.json";

/// The origin in install-source.json, under the same rules as `--relo-origin`; None when it is missing, malformed or not
/// an acceptable origin (the file is a hint, never a reason to fail).
pub fn parse_install_source(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    parse_origin(v.get("origin")?.as_str()?)
}

/// The server the installer came from, for the onboarding to pre-fill when the app was not started with `--relo-origin`
/// (a later launch from the Start menu). Installed builds only: a dev build (`Relo.dev` profile names, profile.rs) must
/// not be steered by the installed app's record. `local_app_data` is passed in so tests never read the real folder.
pub fn install_source(local_app_data: &std::path::Path, dev: bool) -> Option<String> {
    if dev {
        return None;
    }
    let path = local_app_data.join(crate::profile::app_dir_for(false)).join(INSTALL_SOURCE_FILE);
    // The record is a few dozen bytes; anything large is not ours.
    if std::fs::metadata(&path).ok()?.len() > 4096 {
        return None;
    }
    parse_install_source(&std::fs::read_to_string(path).ok()?)
}

/// Exactly `relo://auth/callback[?query]`; no credentials, port or other host/path.
pub fn validate_auth_callback(s: &str) -> Option<String> {
    if s.len() > MAX_URL_LEN {
        return None;
    }
    let u = Url::parse(s).ok()?;
    let ok = u.scheme() == "relo"
        && u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("auth"))
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && (u.path() == "/callback" || u.path() == "/callback/");
    ok.then(|| u.to_string())
}

/// Only https URLs with a host and no embedded credentials may be handed to the shell.
pub fn validate_open_url(s: &str) -> Option<String> {
    if s.len() > MAX_URL_LEN || s.chars().any(|c| c.is_control()) {
        return None;
    }
    let u = Url::parse(s).ok()?;
    let ok = u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty() && u.password().is_none();
    ok.then(|| u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    const CODE: &str = "relo_signin_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const VER: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ.~_-0123";

    #[test]
    fn origin_policy() {
        assert_eq!(parse_origin("https://Relo.example.com/").as_deref(), Some("https://relo.example.com"));
        assert_eq!(parse_origin("http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(parse_origin("http://192.168.1.5:8080").as_deref(), Some("http://192.168.1.5:8080"));
        assert_eq!(parse_origin("http://example.com"), None);
        assert_eq!(parse_origin("https://example.com/dashboard"), None);
        assert_eq!(parse_origin("https://u:p@example.com"), None);
        assert_eq!(parse_origin("https://example.com?x=1"), None);
        assert_eq!(parse_origin("ftp://example.com"), None);
        assert_eq!(parse_origin("nonsense"), None);
    }

    #[test]
    fn code_and_verifier_shapes() {
        assert!(valid_sign_in_code(CODE));
        assert!(!valid_sign_in_code("relo_signin_short"));
        assert!(!valid_sign_in_code(&format!("{CODE}x")));
        assert!(!valid_sign_in_code(&CODE.replace('A', "!")));
        assert!(valid_code_verifier(VER));
        assert!(!valid_code_verifier(&"a".repeat(42)));
        assert!(!valid_code_verifier(&"a".repeat(129)));
        assert!(!valid_code_verifier(&format!("{}/", "a".repeat(50))));
    }

    #[test]
    fn launch_args_need_an_origin_and_drop_bad_extras() {
        assert_eq!(parse_launch_args(&v(&["relo.exe"])), None);
        assert_eq!(parse_launch_args(&v(&["relo.exe", "--relo-origin", "http://evil.com"])), None);
        let a = parse_launch_args(&v(&["x", "--relo-origin", "https://a.io", "--relo-sign-in-code", CODE, "--relo-code-verifier", VER])).unwrap();
        assert_eq!(a.origin, "https://a.io");
        assert_eq!(a.sign_in_code.as_deref(), Some(CODE));
        assert_eq!(a.code_verifier.as_deref(), Some(VER));
        let b = parse_launch_args(&v(&["x", "--relo-origin", "https://a.io", "--relo-sign-in-code", "bad"])).unwrap();
        assert_eq!((b.sign_in_code, b.code_verifier), (None, None));
        // flag as the last argument has no value
        assert_eq!(parse_launch_args(&v(&["x", "--relo-origin"])), None);
    }

    #[test]
    fn at_login_is_read_from_the_arguments_after_the_program() {
        assert!(started_at_login(&v(&["relo.exe", "--at-login"])));
        assert!(!started_at_login(&v(&["relo.exe"])));
        assert!(!started_at_login(&v(&["--at-login"])), "the program name is not an argument");
        let both = parse_launch(&v(&["relo.exe", "--at-login", "--relo-origin", "https://a.io"]));
        assert!(both.at_login);
        assert_eq!(both.hand_off.unwrap().origin, "https://a.io");
        let only = parse_launch(&v(&["relo.exe", "--at-login"]));
        assert!(only.at_login && only.hand_off.is_none());
    }

    #[test]
    fn only_a_bare_second_launch_reopens_the_window() {
        assert!(is_reopen(&v(&["relo.exe"])));
        assert!(!is_reopen(&v(&["relo.exe", "relo://auth/callback?code=1"])));
        assert!(!is_reopen(&v(&["relo.exe", "RELO://auth/callback"])));
        assert!(!is_reopen(&v(&["relo.exe", "--relo-origin", "https://a.io"])));
        assert!(!is_reopen(&v(&["relo.exe", "--at-login"])));
    }

    #[test]
    fn launch_serializes_flat_for_the_page() {
        let j = serde_json::to_value(parse_launch(&v(&["x", "--at-login", "--relo-origin", "https://a.io"]))).unwrap();
        assert_eq!(j["atLogin"], true);
        assert_eq!(j["origin"], "https://a.io");
        let j = serde_json::to_value(parse_launch(&v(&["x"]))).unwrap();
        assert_eq!(j, serde_json::json!({ "atLogin": false }));
    }

    #[test]
    fn install_source_is_read_with_the_origin_rules() {
        assert_eq!(parse_install_source(r#"{"origin":"https://Relo.example.com"}"#).as_deref(), Some("https://relo.example.com"));
        assert_eq!(parse_install_source("\u{feff}{\"origin\":\"http://192.168.1.5:8080/\"}").as_deref(), Some("http://192.168.1.5:8080"));
        for bad in ["", "nope", "{}", r#"{"origin":5}"#, r#"{"origin":"http://example.com"}"#, r#"{"origin":"https://u:p@a.io"}"#, r#"{"origin":"https://a.io/x"}"#, r#"["https://a.io"]"#] {
            assert_eq!(parse_install_source(bad), None, "{bad}");
        }
    }

    #[test]
    fn install_source_file_is_read_for_installed_builds_only() {
        let local = std::env::temp_dir().join(format!("relo-install-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&local);
        assert_eq!(install_source(&local, false), None);
        std::fs::create_dir_all(local.join("Relo")).unwrap();
        std::fs::write(local.join("Relo").join(INSTALL_SOURCE_FILE), r#"{"origin":"https://a.io"}"#).unwrap();
        assert_eq!(install_source(&local, false).as_deref(), Some("https://a.io"));
        // A dev build reads nothing, and never from the installed app's folder.
        assert_eq!(install_source(&local, true), None);
        std::fs::write(local.join("Relo").join(INSTALL_SOURCE_FILE), "x".repeat(5000)).unwrap();
        assert_eq!(install_source(&local, false), None);
        std::fs::write(local.join("Relo").join(INSTALL_SOURCE_FILE), "{ broken").unwrap();
        assert_eq!(install_source(&local, false), None);
        let _ = std::fs::remove_dir_all(&local);
    }

    #[test]
    fn auth_callback_is_strict() {
        assert!(validate_auth_callback("relo://auth/callback?code=1&state=2").is_some());
        assert!(validate_auth_callback("relo://auth/callback").is_some());
        assert!(validate_auth_callback("relo://AUTH/callback?x=1").is_some());
        assert!(validate_auth_callback("relo://auth/other").is_none());
        assert!(validate_auth_callback("relo://evil/callback").is_none());
        assert!(validate_auth_callback("relo://auth/callback/../x").is_none());
        assert!(validate_auth_callback("relo://u@auth/callback").is_none());
        assert!(validate_auth_callback("relo://auth:80/callback").is_none());
        assert!(validate_auth_callback("https://auth/callback").is_none());
        assert!(validate_auth_callback(&format!("relo://auth/callback?{}", "a".repeat(5000))).is_none());
    }

    #[test]
    fn open_url_is_https_only() {
        assert!(validate_open_url("https://relo.example.com/auth?x=1").is_some());
        assert!(validate_open_url("http://relo.example.com").is_none());
        assert!(validate_open_url("file:///C:/Windows/System32/calc.exe").is_none());
        assert!(validate_open_url("javascript:alert(1)").is_none());
        assert!(validate_open_url("https://user:pw@example.com").is_none());
        assert!(validate_open_url("https://example.com/\u{7}").is_none());
        assert!(validate_open_url("calc.exe").is_none());
    }
}
