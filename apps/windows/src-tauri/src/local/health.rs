//! The server's own words: config.json (port, instance), `/health/ready` (status, release, instance) and the rule that a
//! server on the port is this install's only when it names the instance config.json names (LocalServer.swift `probe`).

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub instance: Option<String>,
}

/// `{ "port": 8187, "instance": "..." }`; None without a valid port.
pub fn parse_config(text: &str) -> Option<Config> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let port = v.get("port")?.as_u64().filter(|p| (1..=65535).contains(p))? as u16;
    let instance = v.get("instance").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    Some(Config { port, instance })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub release: String,
    pub instance: String,
}

/// `{ "status": "ok", "release": "...", "instance": "..." }`; None unless status is ok.
pub fn parse_health(body: &str) -> Option<Health> {
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    if v.get("status").and_then(Value::as_str) != Some("ok") {
        return None;
    }
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(Health { release: text("release"), instance: text("instance") })
}

/// What answers on the port in config.json.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Ours { port: u16, health: Health },
    /// Something answers but it is not this install (another Windows user's Relo, or another program).
    Foreign,
    Silent,
}

pub fn is_ours(health: &Health, config_instance: Option<&str>) -> bool {
    match config_instance {
        Some(c) if !c.is_empty() => health.instance == c,
        _ => false,
    }
}

/// Decides a probe from what was read: the config (None = unreadable) and the health on its port (None = no answer).
pub fn classify(config: Option<&Config>, health: Option<Health>) -> Probe {
    match (config, health) {
        (Some(c), Some(h)) => {
            if is_ours(&h, c.instance.as_deref()) {
                Probe::Ours { port: c.port, health: h }
            } else {
                Probe::Foreign
            }
        }
        _ => Probe::Silent,
    }
}

/// The body of an HTTP/1.x response when its status is 200; handles `Transfer-Encoding: chunked`.
pub fn http_ok_body(raw: &[u8]) -> Option<String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let mut lines = head.lines();
    let status = lines.next()?.split_whitespace().nth(1)?;
    if status != "200" {
        return None;
    }
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if !chunked {
        return String::from_utf8(body.to_vec()).ok();
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n")?;
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).ok()?.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[eol + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return None;
        }
        out.extend_from_slice(&rest[..size]);
        rest = rest.get(size + 2..)?;
    }
    String::from_utf8(out).ok()
}

/// GET http://127.0.0.1:<port>/health/ready with a short timeout; the health when the server says ok.
pub fn fetch_health(port: u16) -> Option<Health> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    stream
        .write_all(format!("GET /health/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n").as_bytes())
        .ok()?;
    let mut raw = Vec::new();
    // A read that times out after the body arrived still leaves a complete response.
    let _ = stream.take(256 * 1024).read_to_end(&mut raw);
    parse_health(&http_ok_body(&raw)?)
}

/// "0.2.32" from "0.2.32+257": the number the owner knows, never the build.
pub fn short_version(release: &str) -> &str {
    release.split('+').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_needs_a_port() {
        assert_eq!(parse_config(r#"{"port":8187,"instance":"abc","handle":"owner"}"#), Some(Config { port: 8187, instance: Some("abc".into()) }));
        assert_eq!(parse_config("\u{feff}{\"port\":9}").unwrap().instance, None);
        assert_eq!(parse_config(r#"{"port":0}"#), None);
        assert_eq!(parse_config(r#"{"port":70000}"#), None);
        assert_eq!(parse_config(r#"{"port":"80"}"#), None);
        assert_eq!(parse_config(r#"{"port":80,"instance":""}"#).unwrap().instance, None);
        assert_eq!(parse_config("nope"), None);
    }

    #[test]
    fn health_must_say_ok() {
        let h = parse_health(r#"{"status":"ok","release":"0.1.0","instance":"abc"}"#).unwrap();
        assert_eq!((h.release.as_str(), h.instance.as_str()), ("0.1.0", "abc"));
        assert_eq!(parse_health(r#"{"status":"starting"}"#), None);
        assert_eq!(parse_health("<html>"), None);
        // An older server that names no release or instance still parses, and is never ours.
        assert_eq!(parse_health(r#"{"status":"ok"}"#), Some(Health { release: String::new(), instance: String::new() }));
    }

    #[test]
    fn a_server_is_ours_only_when_the_instance_matches() {
        let cfg = Config { port: 8187, instance: Some("mine".into()) };
        let health = |i: &str| Health { release: "1".into(), instance: i.into() };
        assert!(matches!(classify(Some(&cfg), Some(health("mine"))), Probe::Ours { port: 8187, .. }));
        // Another Windows user's Relo, or another program that happens to say ok.
        assert_eq!(classify(Some(&cfg), Some(health("theirs"))), Probe::Foreign);
        assert_eq!(classify(Some(&cfg), Some(health(""))), Probe::Foreign);
        assert_eq!(classify(Some(&cfg), None), Probe::Silent);
        assert_eq!(classify(None, Some(health("mine"))), Probe::Silent);
        // A config with no instance can never claim a server.
        let bare = Config { port: 1, instance: None };
        assert_eq!(classify(Some(&bare), Some(health(""))), Probe::Foreign);
    }

    #[test]
    fn http_bodies_plain_and_chunked() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}";
        assert_eq!(http_ok_body(plain).as_deref(), Some("{\"status\":\"ok\"}"));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"sta\r\na\r\ntus\":\"ok\"}\r\n0\r\n\r\n";
        assert_eq!(http_ok_body(chunked).as_deref(), Some("{\"status\":\"ok\"}"));
        assert_eq!(http_ok_body(b"HTTP/1.1 503 Service Unavailable\r\n\r\n{}"), None);
        assert_eq!(http_ok_body(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"), None);
        assert_eq!(http_ok_body(b"garbage"), None);
    }

    #[test]
    fn short_version_drops_the_build() {
        assert_eq!(short_version("0.2.32+257"), "0.2.32");
        assert_eq!(short_version("0.1.0"), "0.1.0");
        assert_eq!(short_version(""), "");
    }

    #[test]
    fn a_real_socket_round_trip() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = s.read(&mut buf);
            let body = r#"{"status":"ok","release":"0.1.0","instance":"abc"}"#;
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
        });
        assert_eq!(fetch_health(port), Some(Health { release: "0.1.0".into(), instance: "abc".into() }));
        t.join().unwrap();
        // Nothing listens on the port any more.
        assert_eq!(fetch_health(port), None);
    }
}
