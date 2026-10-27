# Relo for Windows

The notch for Windows (Tauri 2, React). Parity with Relo for Mac (`apps/notch`).

## Run it

```
pnpm --filter @relo/windows dev:app     # the dev app: tauri dev with the dev identifier
pnpm --filter @relo/windows typecheck
pnpm --filter @relo/windows test        # vitest
cargo test --manifest-path apps/windows/src-tauri/Cargo.toml
```

Rust needs the MSVC toolchain (`%USERPROFILE%\.cargo\bin`).

## Dev build and installed app are separate

The dev build and the installed app used to share the identifier `com.example.relo.windows`, so they shared WebView2's data
folders: uninstalling the app with "delete data" wiped the dev app's, and the two fought over one Run value, one set of
credentials and one settings file. They are now separate:

| What | Installed app | Dev build (debug) |
|---|---|---|
| Identifier (WebView data under `%LOCALAPPDATA%\<identifier>`) | `com.example.relo.windows` | `com.example.relo.windows.dev` |
| Settings, media, shelf, logs, state files | `%APPDATA%\Relo`, `%LOCALAPPDATA%\Relo` | `%APPDATA%\Relo.dev`, `%LOCALAPPDATA%\Relo.dev` |
| Credential Manager targets | `Relo/<name>` | `Relo.dev/<name>` |
| Start-with-Windows value (`HKCU\...\Run`) | `Relo` | `Relo (dev)` |
| Local mode's record (`local-mode.json`) | `%LOCALAPPDATA%\Relo` | `%LOCALAPPDATA%\Relo.dev` |

The identifier comes from `src-tauri/tauri.dev.conf.json`, merged over `tauri.conf.json` by `pnpm dev:app`
(`tauri dev --config src-tauri/tauri.dev.conf.json`). A debug build started any other way (plain `tauri dev`) would use the
installed app's identifier, so it stops at start with a message; `RELO_ALLOW_SHARED_IDENTIFIER=1` overrides that. Every Rust
path that derives from the profile goes through `src-tauri/src/profile.rs`.

What the CLI and the local server own is the same in both and does not move: `%LOCALAPPDATA%\Relo\bin\relo.cmd` (and its
Git Bash sibling), the local server's data root `%LOCALAPPDATA%\Relo\server`, and the CLI's own config in `%APPDATA%\relo`.

The first run of a dev build after this change starts with empty dev data (settings, sign-in): the old shared data belongs
to the installed app.

## A plain download: the server it came from and the `relo` command

- **Install source.** The installer writes `%LOCALAPPDATA%\Relo\install-source.json` (`{"origin":"https://host[:port]"}`, from the
  download's Mark-of-the-Web) and opens the app with `--relo-origin <origin>`. Without that flag (a later start from the Start
  menu) the onboarding reads the file instead (`os::install_source`, `launch.rs`), under the same origin rules as the flag,
  and pre-fills the server address and picks "Connect to a server", once, when nothing was typed. A missing, oversized or
  malformed file is ignored. **Installed builds only**: a dev build (`Relo.dev` profile names) returns nothing, so the installed
  app's record never steers it. Only the onboarding uses the file; the notch's origin choice still follows the flag, what
  the owner chose, then the dev default.
- **The `relo` command after a server sign-in.** The Setup step's first row is "The relo command" (`stages.ts` `RELO_ROW`),
  ahead of the agents. `cli_prepare` (`src-tauri/src/cli_setup.rs`) writes `%LOCALAPPDATA%\Relo\bin\relo.cmd` from the bundled
  Node and CLI when it is missing or one this app wrote (the marker rule in `local/launcher.rs`; another relo command is never
  overwritten), adds the folder to the user Path with the CLI's own `setup --path` (skipped when `RELO_NO_REGISTRY_WRITES=1`;
  a Path that cannot be written does not fail the row), and hands the CLI's updates to the app when it wrote the launcher.
  A build without the payload and without a relo command says so in plain words. Until relo.cmd exists the agent list and the
  per-agent setup run the bundled Node and CLI directly.
- **Signing the CLI in.** When the CLI is not already signed in to this server (`cli_setup::signed_in_to`), the notch window,
  which holds the app's device credential, mints a one-time computer invite (`POST /api/devices/self/computer-invites`, owner-client
  `createComputerInvite`) over the `cli_invite_request` / `cli_invite_result` events, and Rust runs
  `relo auth join <code> --api-url <origin> --client-name <PC> --no-setup`, the same join `install.ps1` runs: no terminal, no code
  to type. The code is never logged or stored. Like `install.ps1`'s join it replaces the CLI's active login (no profile).
  Relo for Mac has no remote-server counterpart (its app provisions only its own server, `LocalServer.swift` `installLauncher`
  and `join`); this is the Windows route for a download that did not come from `install.ps1`.
- Agent failures read in plain words with Retry and Skip (`cli_setup::agent_failure_message`); the CLI's output and exit codes
  never reach the screen.

## Start with Windows, quit

- The Run entry launches the app with `--at-login` (`src-tauri/src/autostart.rs`). `launch_args` reports `atLogin`; the
  launch sound plays once per run unless the app was started at sign-in (`src/alerts/lifecycle.ts`). An entry written by an
  earlier build gets the flag the next time the app runs. Local mode's logon task is separate and untouched.
- Quit (tray, Settings) is a round trip (`src-tauri/src/quit.rs`): Rust asks the notch page (`quit_request`), the page plays
  the quit sound and answers `quit_ready(ms)`, Rust exits after that (at most 2 s). If the page does not answer within
  750 ms Rust exits at once; a second quit request exits immediately.

## License

PolyForm Noncommercial License 1.0.0, the repository's (`LICENSE`, `NOTICE`). The app is Relo's own code and not a fork of
boring.notch, so it is not GPL and is part of the public export; `THIRD_PARTY.md` lists what it adapts and links.
