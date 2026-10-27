# Relo for Windows, as this server hands it out

`node scripts/release/build-windows-app.mjs --out apps/server/windows` fills this folder on the owner's Windows machine
before the image is built (or publish the same files to `RELO_ARTIFACTS_DIR/windows`, which the api reads first). It builds
the Tauri app (`apps/windows`) into a per-user NSIS installer that carries the local-mode server it runs (Node, the
server, the Dashboard, PostgreSQL, the CLI: `scripts/release/windows-server-payload.mjs`) and the `ReloServer.exe`
sidecar, signs with Authenticode when `RELO_WINDOWS_CERT_FILE` or `RELO_WINDOWS_CERT_THUMBPRINT` is set (first every
executable the payload carries: `node.exe`, `ReloServer.exe`, PostgreSQL's `.exe` and `.dll` files and native `.node`
addons, as the Mac signs every Mach-O; then the installer; without a certificate the build warns and the manifest says
`"signed": false`), and writes:

- `relo-windows-setup.exe`: Relo Setup (`apps/windows/setup`), the download. It carries the NSIS installer, shows a small Relo
  window while it runs it silently, opens Relo and goes away; the Mark-of-the-Web of the download names this server, which it
  passes to Relo (`install-source.json`, `--relo-origin`). Served at `/windows/relo-setup.exe`; it is the download the landing
  page links to, and `install.ps1 -WindowsApp` runs it with `/S /D=%LOCALAPPDATA%\Programs\Relo` (no window, nothing opened;
  its arguments go to the NSIS installer).
- `relo-windows.zip`: the NSIS installer zipped (not Relo Setup), the update payload. Served at `/windows/relo-windows.zip`.
- `manifest.json`: `version`, `build` (the number of commits to what the app carries, like the Mac's build number),
  `sha256` (of the installer), `executable`, `signature` (the minisign signature of the zip from
  `TAURI_SIGNING_PRIVATE_KEY`), `notes`, `pubDate`, `signed`, and `critical` (only with `--critical`). Without
  `signature` there is no update feed.
- the update feed, not a file: `/windows/update.json` is made from the manifest in the Tauri updater's static format
  (`version`, `notes`, `pub_date`, `platforms.windows-x86_64.{signature,url}`). Installed apps compare its version with
  their own and install the zip when it is newer. A build made with `--critical` adds `"critical": true` to the feed;
  the app shows it as an important update.

Without these files (every public image: the built installer is made on the owner's machine and signed with the owner's
certificate, so it is never part of the image; the app's source is in the repository under PolyForm Noncommercial, see
`apps/windows/NOTICE`) the install script says the server has no Windows app, the downloads are 404 and the landing page offers no Windows download.

## Building it (on Windows)

Needs Windows 11, Node 22, pnpm 11.20 (`npx -y pnpm@11.20.0 install --frozen-lockfile`), the Rust MSVC toolchain and the
workspace packages built (`@relo/contracts`, `@relo/owner-client`, `@relo/server`). Then:

```
node scripts/release/build-windows-app.mjs --out apps/server/windows --notes "What changed"
```

It builds the payload (downloads and verifies Node and PostgreSQL once, cached), `ReloServer.exe`, and the NSIS installer
with both bundled: `server\` and `ReloServer.exe` end up next to `Relo.exe` in the install folder. A full build
takes about 7 minutes on a cold cargo cache and the installer is about 51 MB (remote-only, `--no-server`, is about 7 MB).
`RELO_WINDOWS_SERVER_PAYLOAD` and `RELO_WINDOWS_SERVER_LAUNCHER` reuse a payload folder or a built launcher.

## Updater signing

Installed apps only accept an update whose zip is signed with the key matching `plugins.updater.pubkey` in
`apps/windows/src-tauri/tauri.conf.json`. The repository carries the placeholder `TODO_REPLACE_WITH_MINISIGN_PUBLIC_KEY`
and must keep it until the owner sets the real key. The private key never goes in the repository (`*.key` is ignored).

1. Generate the pair once, outside the checkout (use a password):
   `npx -y pnpm@11.20.0 --filter @relo/windows tauri signer generate -w "$HOME\.relo-secrets\windows-updater.key" -p "<password>"`.
   It writes the private key and `windows-updater.key.pub`. Back both up; losing the private key means no installed app can
   be updated again, and apps ship with the public key baked in.
2. Put the contents of the `.pub` file into `tauri.conf.json` as `plugins.updater.pubkey`, and the update feed URL
   (`https://<your server>/windows/update.json`) into `plugins.updater.endpoints`, then commit that (public) change before
   building the release.
3. Build with the private key in the environment: `TAURI_SIGNING_PRIVATE_KEY` (the text, or the path to the key file) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The build script signs `relo-windows.zip` with it and writes the signature to
   `manifest.json`; without it there is no `signature` and the server serves no update feed.

For a local trial, a throwaway pair works the same way; an app built with the placeholder key cannot verify any update.

`RELO_WINDOWS_ORIGIN` (for example `https://relo.example.com`) bakes the server address the app suggests on its first
screen into the build (`VITE_RELO_ORIGIN`); unset, the owner types it.

## Authenticode (not set up yet)

Without `RELO_WINDOWS_CERT_FILE` (+ `RELO_WINDOWS_CERT_PASSWORD`) or `RELO_WINDOWS_CERT_THUMBPRINT` the installer is
unsigned (`"signed": false` in the manifest) and SmartScreen warns people who run it ("unknown publisher"). `deploy.sh`
publishes it anyway, with a warning: the owner accepted that warning until there is a certificate. It still requires the
updater signature and matching digests. Buy an Authenticode (OV or EV) certificate and set one of those variables to
remove the warning.

## Publishing with a release

`docs/internal/operations/release/deploy.sh` runs on the Mac, so the Windows build is brought to it. After building (and
signing) on Windows, copy the output folder (`relo-windows-setup.exe`, `relo-windows.zip`, `manifest.json`) to the Mac and run

```
RELO_WINDOWS_ARTIFACTS=/path/to/windows pnpm deploy:prod
```

Unset, a Mac-only release works exactly as before. Set, the release publishes the folder to
`~/services/relo-artifacts/windows` on the host (zip and installer first, manifest last, like the Mac) and checks
`/windows/relo-setup.exe` on the public origin reports the manifest's version. Like the Mac app, only a signed build goes
out: the manifest must say `"signed": "authenticode"`, carry the updater `signature`, and match the files' SHA-256; otherwise
the release says so and the Windows app people have stays as it is.

## Installing and uninstalling

The installer is per user (no administrator prompt) and needs Windows 10 version 1809 or later, 64-bit; an older one
says so and stops (`installer-hooks.nsh`). It writes `HKCU\Software\Classes\relo` (the `relo://` scheme, which replaces
any other registration, including a development build's), `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relo`,
`HKCU\Software\Relo\Relo` (the install folder) and `Start Menu\Programs\Relo\Relo.lnk`.

Uninstalling (and updating) first stops the local server: `ReloServer.exe stop` (graceful, up to 90 s), so no file is in
use. An uninstall also runs `ReloServer.exe uninstall-login`, which removes the "Relo Server" logon task and its Run
fallback; an update keeps the task. A silent uninstall (`uninstall.exe /S`) then removes the folder, the `relo://` key, the
uninstall entry, the shortcut and the app's `Run` value, and keeps the data. The "Delete the application data" box (not
available silently) also removes `%LOCALAPPDATA%\com.example.relo.windows`, `%APPDATA%\com.example.relo.windows`,
`HKCU\Software\Relo`, and the local server's data, `%LOCALAPPDATA%\Relo\server` and `local-mode.json`, but only if the
server stopped ("Relo is still stopping, so its data was kept."). The CLI's launcher and Node in `%LOCALAPPDATA%\Relo`
and its config in `%APPDATA%\relo` stay; the agents' instructions are removed by the app's Settings -> Uninstall Relo
from this PC, as on the Mac. A development build (`pnpm dev:app`) has its own identifier and folders
(`apps/windows/README.md`).

Never test the uninstaller on a profile whose data matters: it resolves `%LOCALAPPDATA%` through the shell and ignores
environment overrides. Review `installer-hooks.nsh` instead.
