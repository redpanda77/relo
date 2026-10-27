# ReloServer.exe: Relo's local server on Windows

The Windows twin of `apps/notch/ReloServerLauncher/main.swift`. Relo for Windows carries Node, the server, the
Dashboard, migrations, PostgreSQL 17 and the CLI, and runs them on `127.0.0.1` with no account, server or iPhone
(local mode, `docs/site/get-started/mac.md`). `ReloServer.exe` is a console-less program (`windows_subsystem =
"windows"`, std only, about 270 KB) that starts the bundled supervisor and stops it gracefully.

Build: `cargo build --release` here (output `target\release\ReloServer.exe`); `cargo test` for the unit tests,
`cargo test -- --ignored` also registers and removes a throwaway Task Scheduler task.

## Layout

```
<app dir>\ReloServer.exe
<app dir>\release-identity.txt        optional fallback; server\release-identity.txt (the payload build's) wins
<app dir>\server\                     the payload, from scripts/release/windows-server-payload.mjs OUT_DIR
    node.exe  VERSION  release-identity.txt  NODE-LICENSE   (release-identity.txt: the app version, written by the payload build; the app reads the same file)
    app\server\{dist,migrations,node_modules,package.json,cli}   dist\local\main.js is the supervisor
    app\dashboard\dist
    app\postgres\bin\{postgres,pg_ctl,initdb}.exe
    cli\bin\relo.mjs                  the unpacked CLI (run it with server\node.exe)
<data root> = %LOCALAPPDATA%\Relo\server
    config.json  db\  secrets\  logs\{relo.log,postgres.log}  backups\  run\supervisor.json
```

## ReloServer.exe commands

All take `--root <data root>` (default `%LOCALAPPDATA%\Relo\server`) and `--payload <dir>` (default
`<exe dir>\server`).

| Command | What it does |
|---|---|
| `ReloServer.exe` or `run [--port N]` | Starts `server\node.exe app\server\dist\local\main.js run --root <root> --stop-on-stdin-close` with `RELO_POSTGRES_BIN` and `RELO_RELEASE_IDENTITY` set (env, else `release-identity.txt`, else `server\VERSION`). stdout and stderr are appended to `<root>\logs\relo.log`. It blocks until the supervisor exits and returns its exit code. `--port` only matters on the very first start (config.json then holds the port). |
| `stop` | Asks the running supervisor to stop (see below) and waits up to 90 s for it. Exit 0 when stopped or nothing was running. |
| `install-login` | Registers the per-user Task Scheduler task "Relo Server" (at this user's logon, limited token, no time limit, runs `ReloServer.exe`). If a task can't be made, falls back to `HKCU\...\Run`. Prints `Task` or `RunKey`. Never elevated. |
| `uninstall-login` | Removes both forms. |
| `login-status` | Prints `Task` or `RunKey` and exits 0 when registered; exits 1 when not. |

The same functions are the library `relo_server_launcher` (`login::register_login`, `unregister_login`,
`login_status`, `request_stop`, `control_pipe_name`, `Payload`), usable from the app as a path dependency.

A windowed program has no console, so `Start-Process -Wait` (or `.spawn()` and `wait()`) is how a caller waits for
`stop`; PowerShell's `&` returns at once.

## The supervisor (`main.js`) interface the app builds on

`node.exe app\server\dist\local\main.js <command> --root <root> [options]`, unchanged on the Mac:

- `prepare [--port N]` first-run work (layout, secrets, database, migrations, owner), leaves PostgreSQL stopped. Prints
  `{"prepared":true,"port":8187}`. Fails with "already running" while a supervisor holds the root.
- `run [--port N] [--stop-on-stdin-close]` serves until stopped. `{"event":"serving",...}` is logged when ready;
  `GET http://127.0.0.1:<port>/health/ready` answers `{"status":"ok","release":...,"instance":...}`.
- `invite [--level L] [--approvals] [--agent A]...` prints `{"code","expiresAt","apiUrl","macApp"}` (needs a running install;
  the computer is named "This PC").
- `owner` prints `{"email","passwordFile","dashboard"}`.
- `stop` (Windows) asks the running supervisor to stop and waits for it; prints `{"stopped":true,"wasRunning":bool}`.
- `--root` may be omitted on Windows (the default above). Exit code 1 and a one-line stderr message on failure.

`config.json` (re-read by the app): `port` (API), `dbPort` (PostgreSQL, Windows only, loopback TCP), `handle`,
`instance` (random id the health endpoint reports), `release`.

### Stopping gracefully (Windows has no SIGTERM)

Three equivalent ways, all drain the API and worker and run `pg_ctl stop -m fast`:

1. Named pipe `\\.\pipe\relo-local-<16 hex>`: write `stop\n`. The name is FNV-1a 64 of the lower-cased data root path
   (`controlPipeName` in `apps/server/src/local/layout.ts`, `control_pipe_name` here; both pin the same test vector).
   `ReloServer.exe stop` and `main.js stop` do this.
2. Closing the supervisor's stdin when started with `--stop-on-stdin-close`: `ReloServer.exe` holds that pipe, so if the
   launcher dies for any reason (killed, crashed, logged off) the server still stops cleanly.
3. The API and worker are children over IPC; if the supervisor itself is hard-killed they stop on their own.

The pipe is also a lock: a second `run` or a `prepare` on the same root fails with "already running" instead of
fighting over the database. A PostgreSQL that outlived a hard-killed supervisor keeps running and is adopted by the next
`run` on its existing port (`postgres_adopted` in the log).

### Failures to show the user

PostgreSQL refuses an administrator token. `run`/`prepare` in an elevated window fail with "Relo's database can't run
from an administrator (elevated) session..." (also in `relo.log`).

## Not done here

- Task Scheduler "End" may terminate the whole process tree at once, so a task stop can skip the graceful path (crash
  recovery then makes PostgreSQL safe on the next start). Use `ReloServer.exe stop` first.
- Data-folder ACL hardening (icacls); the default `%LOCALAPPDATA%` is already per-user.
- No backups with `pg_dump` (the Windows PostgreSQL package has none): a new release copies the stopped `db\` folder to
  `backups\`, as on the Mac.
