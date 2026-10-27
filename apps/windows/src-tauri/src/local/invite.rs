//! The invite and the sign-in handoff (LocalServer.swift `invite`, `pkce`, `join`): the supervisor prints a one-time
//! computer invite as JSON; the CLI's `auth join` signs the CLI in to the `local` profile and returns the app's own
//! sign-in code, which the app exchanges with its PKCE verifier. The verifier never leaves Rust until it is handed to
//! the notch window that signs in.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The CLI profile this app's local mode lives in; the owner's other profiles are never touched.
pub const LOCAL_PROFILE: &str = "local";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub code: String,
    pub api_url: String,
}

/// The last line of the supervisor's output that is an invite: `rci_` code and a loopback API URL.
pub fn parse_invite(output: &str) -> Option<Invite> {
    for line in output.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(code) = v.get("code").and_then(Value::as_str).filter(|c| c.starts_with("rci_")) else { continue };
        let Some(api) = v.get("apiUrl").and_then(Value::as_str) else { continue };
        if !is_loopback_api(api) {
            continue;
        }
        return Some(Invite { code: code.into(), api_url: api.trim_end_matches('/').into() });
    }
    None
}

/// `http://127.0.0.1:<port>` or `http://localhost:<port>`, nothing else.
pub fn is_loopback_api(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost")) && u.username().is_empty() && u.query().is_none()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce_from(bytes: &[u8]) -> Pkce {
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

pub fn pkce() -> Result<Pkce, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(pkce_from(&bytes))
}

pub fn invite_args(supervisor: &str, root: &str, level: &str, agents: &[String]) -> Vec<String> {
    let mut a: Vec<String> = [supervisor, "invite", "--root", root, "--mac-app", "--level", level].iter().map(|s| s.to_string()).collect();
    for id in agents {
        a.push("--agent".into());
        a.push(id.clone());
    }
    a
}

/// `relo auth join` for the local profile. `set_up_agents: false` adds `--no-setup`: link the command and the app only.
pub fn join_args(cli: &str, code: &str, api_url: &str, challenge: &str, client_name: &str, set_up_agents: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        cli, "auth", "join", code, "--api-url", api_url, "--local", "--profile", LOCAL_PROFILE, "--client-name", client_name, "--mac-app-challenge",
        challenge,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !set_up_agents {
        a.push("--no-setup".into());
    }
    a
}

/// The first string at `key` in the CLI's JSON lines, searched through nested objects.
pub fn first_string(key: &str, output: &str) -> Option<String> {
    fn find(v: &Value, key: &str) -> Option<String> {
        match v {
            Value::Object(m) => {
                if let Some(Value::String(s)) = m.get(key) {
                    return Some(s.clone());
                }
                m.values().find_map(|c| find(c, key))
            }
            Value::Array(a) => a.iter().find_map(|c| find(c, key)),
            _ => None,
        }
    }
    output.lines().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().and_then(|v| find(&v, key)))
}

/// The sign-in code must have the shape the owner client accepts.
pub fn valid_app_sign_in_code(s: &str) -> bool {
    crate::launch::valid_sign_in_code(s)
}

/// A name for this PC as the dashboard lists it, at most 80 characters.
pub fn client_name(computer: Option<&str>) -> String {
    let name = computer.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("This PC");
    name.chars().take(80).collect()
}

/// The host of the server a relo command on this PC is signed in to: the active profile of the CLI's config, unless
/// Relo for Windows made it. The address never decides: an SSH tunnel to a remote server is loopback too.
pub fn remote_login_host(config_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(config_json.trim_start_matches('\u{feff}')).ok()?;
    let profiles = v.get("profiles")?.as_object().filter(|p| !p.is_empty())?;
    let active = v.get("activeProfile").and_then(Value::as_str).filter(|n| profiles.contains_key(*n));
    let name = match active {
        Some(n) => n.to_string(),
        None => {
            let mut keys: Vec<&String> = profiles.keys().collect();
            keys.sort();
            keys[0].clone()
        }
    };
    let profile = profiles.get(&name)?;
    if profile.get("local").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let host = url::Url::parse(profile.get("apiUrl")?.as_str()?).ok()?.host_str()?.to_string();
    (!host.is_empty()).then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_comes_from_the_last_valid_line() {
        let out = "noise\n{\"code\":\"rci_abc\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"apiUrl\":\"http://127.0.0.1:8187\",\"macApp\":true}\n";
        assert_eq!(parse_invite(out), Some(Invite { code: "rci_abc".into(), api_url: "http://127.0.0.1:8187".into() }));
        assert_eq!(parse_invite("{\"code\":\"rci_abc\",\"apiUrl\":\"http://localhost:1/\"}").unwrap().api_url, "http://localhost:1");
    }

    #[test]
    fn invite_refuses_other_codes_and_remote_servers() {
        assert_eq!(parse_invite("{\"code\":\"xyz\",\"apiUrl\":\"http://127.0.0.1:1\"}"), None);
        assert_eq!(parse_invite("{\"code\":\"rci_a\",\"apiUrl\":\"https://relo.example.com\"}"), None);
        assert_eq!(parse_invite("{\"code\":\"rci_a\",\"apiUrl\":\"http://evil.test:8187\"}"), None);
        assert_eq!(parse_invite("{\"code\":\"rci_a\",\"apiUrl\":\"http://127.0.0.1@evil.test:80\"}"), None);
        assert_eq!(parse_invite("not json"), None);
    }

    #[test]
    fn pkce_matches_the_rfc_vector() {
        // RFC 7636 appendix B: this verifier hashes to this challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let p = pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(crate::launch::valid_code_verifier(&p.verifier));
        assert_eq!(p.challenge.len(), 43);
        assert_ne!(pkce().unwrap().verifier, p.verifier);
        assert_eq!(pkce_from(&[0u8; 32]).verifier, "A".repeat(43));
    }

    #[test]
    fn join_arguments_name_the_local_profile() {
        let a = join_args("cli", "rci_x", "http://127.0.0.1:8187", "CH", "PC", true);
        assert_eq!(
            a.join(" "),
            "cli auth join rci_x --api-url http://127.0.0.1:8187 --local --profile local --client-name PC --mac-app-challenge CH"
        );
        assert_eq!(join_args("cli", "rci_x", "u", "CH", "PC", false).last().map(String::as_str), Some("--no-setup"));
        let i = invite_args("main.js", "R", "guide", &["claude-code".into(), "codex".into()]);
        assert_eq!(i.join(" "), "main.js invite --root R --mac-app --level guide --agent claude-code --agent codex");
    }

    #[test]
    fn the_sign_in_code_is_found_in_json_lines() {
        let out = "{\"step\":\"x\"}\n{\"joined\":{\"macAppSignInCode\":\"relo_signin_abc\"}}\n";
        assert_eq!(first_string("macAppSignInCode", out).as_deref(), Some("relo_signin_abc"));
        assert_eq!(first_string("macAppSignInCode", "{}\nplain"), None);
    }

    #[test]
    fn client_name_is_short_and_never_empty() {
        assert_eq!(client_name(None), "This PC");
        assert_eq!(client_name(Some("  ")), "This PC");
        assert_eq!(client_name(Some(&"x".repeat(200))).len(), 80);
    }

    #[test]
    fn a_login_to_a_server_is_named_but_a_local_one_is_not() {
        let remote = r#"{"activeProfile":"work","profiles":{"work":{"apiUrl":"https://relo.example.com"},"local":{"apiUrl":"http://127.0.0.1:8187","local":true}}}"#;
        assert_eq!(remote_login_host(remote).as_deref(), Some("relo.example.com"));
        let local = r#"{"activeProfile":"local","profiles":{"local":{"apiUrl":"http://127.0.0.1:8187","local":true}}}"#;
        assert_eq!(remote_login_host(local), None);
        // A tunnel to a remote server is loopback and still a remote login.
        let tunnel = r#"{"profiles":{"a":{"apiUrl":"http://127.0.0.1:9000"}}}"#;
        assert_eq!(remote_login_host(tunnel).as_deref(), Some("127.0.0.1"));
        assert_eq!(remote_login_host("{}"), None);
    }
}
