//! The parts of Relo Setup that need no window: which server a download came from, the command line handed to the NSIS
//! installer, and the words and paths. (main.rs is the window and the install.)

/// The origin (`https://host[:port]`) of a download URL that is Relo's own, or None.
///
/// https anywhere, http only for a local server (`localhost`, `127.0.0.1`); the path (any query or fragment dropped) must end in
/// `/windows/relo-setup.exe` or `/relo-windows-setup.exe`, the names a Relo server hands the installer out under
/// (apps/server/src/api/computer-invite-routes.ts); the host is letters, digits, dots and dashes (no user name, no spaces),
/// the port digits. Nothing else is ever turned into an origin, and no server is named here: each Relo server serves its own
/// installer and the origin is read from the download. The same rules as installer-hooks.nsh (ReloOriginOf).
pub fn origin_of(url: &str) -> Option<String> {
    let url = url.trim_matches(|c: char| c == '\r' || c == '\n' || c == ' ' || c == '\t');
    let url = url.split(['?', '#']).next()?;
    let lower = url.to_ascii_lowercase();
    let (scheme, rest) = if let Some(rest) = lower.strip_prefix("https://") {
        ("https://", rest)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        ("http://", rest)
    } else {
        return None;
    };
    let slash = rest.find('/')?;
    if slash == 0 {
        return None;
    }
    let (authority, path) = rest.split_at(slash);
    if !(path.ends_with("/windows/relo-setup.exe") || path.ends_with("/relo-windows-setup.exe")) {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-') {
        return None;
    }
    if let Some(port) = port {
        if port.is_empty() || port.len() > 5 || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    if scheme == "http://" && host != "localhost" && host != "127.0.0.1" {
        return None;
    }
    Some(format!("{scheme}{authority}"))
}

/// The value of `key=` at the start of a line of a Zone.Identifier stream (so a URL that merely contains the words is not it).
fn zone_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let line = line.trim_start_matches('\u{feff}');
        (line.len() >= key.len() && line.is_char_boundary(key.len()) && line[..key.len()].eq_ignore_ascii_case(key)).then(|| &line[key.len()..])
    })
}

/// Relo's server origin from the text of the Mark-of-the-Web the browser put on this program: `HostUrl=` first (where the
/// file itself came from), then `ReferrerUrl=` (the page that linked to it).
pub fn origin_from_zone_identifier(text: &str) -> Option<String> {
    ["HostUrl=", "ReferrerUrl="].iter().find_map(|key| zone_value(text, key).and_then(origin_of))
}

/// The stream's bytes as text (the browsers write ASCII or UTF-8; some tools write UTF-16 with a byte order mark).
pub fn decode_stream(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// `{"origin":"https://host[:port]"}`, the file install-source.json holds.
pub fn install_source_json(origin: &str) -> String {
    format!("{{\"origin\":\"{origin}\"}}")
}

/// True when the arguments ask for a silent install (`/S`, as NSIS spells it): no window, nothing opened.
pub fn is_silent(args: &[String]) -> bool {
    args.iter().any(|a| a == "/S" || a == "/s")
}

/// The command line for the NSIS installer: `/S` first (this program is the window, the installer shows none), then every
/// argument given to this program as it was, with `/D=<folder>` last and unquoted, the only way NSIS reads it.
pub fn nsis_command_line(args: &[String]) -> String {
    let mut parts = vec!["/S".to_string()];
    let mut install_dir = None;
    for arg in args {
        if arg == "/S" || arg == "/s" {
            continue;
        }
        if arg.len() >= 3 && arg[..3].eq_ignore_ascii_case("/D=") {
            install_dir = Some(arg.clone());
        } else if arg.is_empty() || arg.contains(' ') || arg.contains('\t') {
            parts.push(format!("\"{}\"", arg.replace('"', "")));
        } else {
            parts.push(arg.clone());
        }
    }
    parts.extend(install_dir);
    parts.join(" ")
}

/// Where the installer puts Relo for the current user (installer-hooks.nsh): `%LOCALAPPDATA%\Programs\Relo\Relo.exe`.
pub fn default_relo_exe(local_app_data: &str) -> String {
    format!("{}\\Programs\\Relo\\Relo.exe", local_app_data.trim_end_matches('\\'))
}

/// Where install-source.json goes: `%LOCALAPPDATA%\Relo\install-source.json`.
pub fn install_source_path(local_app_data: &str) -> String {
    format!("{}\\Relo\\install-source.json", local_app_data.trim_end_matches('\\'))
}

/// The folder an `reg query HKCU\Software\Relo\Relo /ve` answer names (the NSIS installer writes its folder there).
pub fn install_dir_from_reg_query(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (_, value) = line.split_once("REG_SZ")?;
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// What the window says, per state: (headline, small line).
pub fn words(state: &str) -> (&'static str, &'static str) {
    match state {
        "updating" => ("Updating Relo\u{2026}", ""),
        "opening" => ("Opening Relo\u{2026}", ""),
        "done" => ("Relo is installed", "Find it in your Start menu."),
        "failed" => ("Relo couldn't finish installing", "Check that you have some free space and try again."),
        "needsinstaller" => ("This copy of Relo Setup is incomplete", "Download Relo again from your Relo server."),
        _ => ("Installing Relo\u{2026}", ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn origin_comes_only_from_relos_own_download() {
        assert_eq!(origin_of("https://relo.example.com/windows/relo-setup.exe\r\n").as_deref(), Some("https://relo.example.com"));
        assert_eq!(origin_of("https://relo.example.com:8443/windows/relo-setup.exe?x=1#y").as_deref(), Some("https://relo.example.com:8443"));
        assert_eq!(origin_of("https://Relo.Example.com/prefix/windows/relo-setup.exe").as_deref(), Some("https://relo.example.com"));
        assert_eq!(origin_of("https://relo.example.com/relo-windows-setup.exe").as_deref(), Some("https://relo.example.com"));
        assert_eq!(origin_of("http://localhost:3000/windows/relo-setup.exe").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin_of("http://127.0.0.1/windows/relo-setup.exe").as_deref(), Some("http://127.0.0.1"));
        for bad in [
            "http://evil.com/windows/relo-setup.exe",
            "https://relo.example.com/other.exe",
            "https://relo.example.com/",
            "https://relo.example.com",
            "https://user@evil.com/windows/relo-setup.exe",
            "https://evil.com:80a/windows/relo-setup.exe",
            "https://evil.com:/windows/relo-setup.exe",
            "https://evil.com:123456/windows/relo-setup.exe",
            "https:///windows/relo-setup.exe",
            "ftp://x.com/windows/relo-setup.exe",
            "https://a b.com/windows/relo-setup.exe",
            "https://[::1]/windows/relo-setup.exe",
            "",
        ] {
            assert_eq!(origin_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_mark_of_the_web_names_the_host_first_and_ignores_lookalikes() {
        let both = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://x.io/?HostUrl=https://evil.com/windows/relo-setup.exe\r\nHostUrl=https://relo.example.com/windows/relo-setup.exe\r\n";
        assert_eq!(origin_from_zone_identifier(both).as_deref(), Some("https://relo.example.com"));
        let trap = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://x.io/?HostUrl=https://evil.com/windows/relo-setup.exe\r\n";
        assert_eq!(origin_from_zone_identifier(trap), None);
        let referrer = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://relo.me:8443/windows/relo-setup.exe\r\nHostUrl=https://cdn.other/file.exe\r\n";
        assert_eq!(origin_from_zone_identifier(referrer).as_deref(), Some("https://relo.me:8443"));
        assert_eq!(origin_from_zone_identifier("[ZoneTransfer]\r\nZoneId=3\r\n"), None);
        let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("HostUrl=http://localhost:1/windows/relo-setup.exe".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(origin_from_zone_identifier(&decode_stream(&utf16)).as_deref(), Some("http://localhost:1"));
    }

    #[test]
    fn the_installer_gets_s_first_and_the_install_folder_last() {
        assert_eq!(nsis_command_line(&[]), "/S");
        assert_eq!(nsis_command_line(&args(&["/S", "/D=C:\\Users\\A B\\Programs\\Relo"])), "/S /D=C:\\Users\\A B\\Programs\\Relo");
        assert_eq!(nsis_command_line(&args(&["/D=C:\\x y", "/P", "/ARGS", "a b"])), "/S /P /ARGS \"a b\" /D=C:\\x y");
        assert!(is_silent(&args(&["/S"])));
        assert!(!is_silent(&args(&["/P"])));
    }

    #[test]
    fn paths_and_the_registry_answer() {
        assert_eq!(default_relo_exe("C:\\Users\\a\\AppData\\Local"), "C:\\Users\\a\\AppData\\Local\\Programs\\Relo\\Relo.exe");
        assert_eq!(install_source_path("C:\\L\\"), "C:\\L\\Relo\\install-source.json");
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Relo\\Relo\r\n    (Default)    REG_SZ    C:\\Users\\a\\AppData\\Local\\Programs\\Relo\r\n\r\n";
        assert_eq!(install_dir_from_reg_query(out).as_deref(), Some("C:\\Users\\a\\AppData\\Local\\Programs\\Relo"));
        assert_eq!(install_dir_from_reg_query("ERROR: The system was unable to find the specified registry key or value."), None);
        assert_eq!(install_source_json("https://a.io"), "{\"origin\":\"https://a.io\"}");
    }
}
