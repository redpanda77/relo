// ReloServer.exe: Relo for Windows' background server, the program the login task starts (the twin of
// apps/notch/ReloServerLauncher/main.swift). No console window. It runs the bundled Node with the server's local-mode
// supervisor, data under %LOCALAPPDATA%\Relo\server, and tells it the app's version so the app can see after an update
// that the running server is an older one. Output goes to <root>\logs\relo.log (appended). It holds the supervisor's
// stdin: when this process ends, however it ends, the supervisor stops gracefully (drains the API and the worker, stops
// PostgreSQL). `ReloServer.exe stop` asks a running one to stop. README.md has the whole interface.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::exit;
use std::time::Duration;

use relo_server_launcher::{default_data_root, login, open_log, request_stop, start_server, wait_stopped, Payload};

struct Options {
    command: String,
    payload: Option<PathBuf>,
    root: Option<PathBuf>,
    port: Option<u16>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options { command: "run".into(), payload: None, root: None, port: None };
    let mut iterator = args.iter().peekable();
    if let Some(first) = iterator.peek() {
        if !first.starts_with("--") {
            options.command = iterator.next().cloned().unwrap_or_default();
        }
    }
    while let Some(flag) = iterator.next() {
        let mut value = || iterator.next().cloned().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--payload" => options.payload = Some(PathBuf::from(value()?)),
            "--root" => options.root = Some(PathBuf::from(value()?)),
            "--port" => options.port = Some(value()?.parse().map_err(|_| "--port needs a number".to_string())?),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(options)
}

fn say(message: &str) {
    // A windowed program has no console: errors reach the log, and the exit code.
    eprintln!("{message}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(&args) {
        Ok(options) => options,
        Err(message) => {
            say(&format!("relo-server: {message}"));
            exit(2);
        }
    };
    let exe = std::env::current_exe().unwrap_or_default();
    let Some(root) = options.root.clone().or_else(default_data_root) else {
        say("relo-server: no data folder (LOCALAPPDATA is not set)");
        exit(2);
    };
    let code = match options.command.as_str() {
        "run" => run(&options, &exe, &root),
        "stop" => {
            let was_running = request_stop(&root);
            let stopped = !was_running || wait_stopped(&root, Duration::from_secs(90));
            if stopped { 0 } else { 1 }
        }
        "install-login" => match login::register_login(&exe) {
            Ok(method) => { println!("{method:?}"); 0 }
            Err(error) => { say(&format!("relo-server: {error}")); 1 }
        },
        "uninstall-login" => match login::unregister_login() {
            Ok(_) => 0,
            Err(error) => { say(&format!("relo-server: {error}")); 1 }
        },
        "login-status" => match login::login_status() {
            Some(method) => { println!("{method:?}"); 0 }
            None => 1,
        },
        other => {
            say(&format!("relo-server: unknown command {other} (run, stop, install-login, uninstall-login, login-status)"));
            2
        }
    };
    exit(code);
}

fn run(options: &Options, exe: &std::path::Path, root: &std::path::Path) -> i32 {
    let payload = options.payload.clone().map(|dir| Payload { dir }).unwrap_or_else(|| Payload::beside(exe));
    let log = match open_log(root) {
        Ok(log) => log,
        Err(error) => {
            say(&format!("relo-server: can't open relo.log: {error}"));
            return 1;
        }
    };
    if let Err(message) = payload.check() {
        use std::io::Write;
        let _ = writeln!(&log, "relo-server: {message}");
        return 1;
    }
    let identity = payload.release_identity(std::env::var("RELO_RELEASE_IDENTITY").ok());
    let mut running = match start_server(&payload, root, options.port, &identity, &log) {
        Ok(running) => running,
        Err(error) => {
            use std::io::Write;
            let _ = writeln!(&log, "relo-server: couldn't start {}: {error}", payload.node().display());
            return 1;
        }
    };
    // `running.stdin` stays open until this function returns or the process dies.
    match running.child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    }
}
