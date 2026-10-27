# Relo for Mac, as this server hands it out

`pnpm deploy:prod` fills this folder on the owner's Mac before the image is built. `scripts/release/build-mac-app.sh`
builds Relo for Mac (`apps/notch`, Apple silicon only), embeds the server it runs (Node, the server, the Dashboard,
PostgreSQL, the CLI: `scripts/release/mac-server-payload.sh` and `scripts/release/embed-server.sh`), signs it with
Developer ID, notarizes and staples it, and writes:

- `relo-mac.zip`: the app, the update itself. Served at `/mac/relo-mac.zip`; `install.sh --mac-app` installs it.
- `relo-mac.dmg`: the app and an Applications link, signed, notarized and stapled. Served at `/mac/relo-mac.dmg`; it is
  the download the docs link to, and the install.
- `manifest.json`: `version`, `shortVersion`, `build`, `sha256`, `app`, `executable`, `signed`, `notarized`, `edSignature`,
  `length`, `minimumSystemVersion`. The build number counts every commit to what the app carries (the notch app, the
  server, the Dashboard, the contracts, the CLI and its skill, the release scripts, the lockfile), so any change is a
  newer build.
- the appcast, not a file: `/mac/appcast.xml` is made from the manifest (one item, the zip with its EdDSA signature,
  `minimumSystemVersion`, `hardwareRequirements` arm64). Installed apps check it hourly through Sparkle and install
  the build when its number is higher.

The app embeds the server: a Mac that runs Relo locally needs nothing else, and the app's login agent
(`Contents/Library/LaunchAgents`) starts it with data under `~/Library/Application Support/Relo/server` and its log in
`logs/relo.log`. `deploy.sh` publishes a Mac app only when the manifest says `signed` is `developer-id` and `notarized`
is true; otherwise the app people already have stays. The image copies the folder; the api serves the files (streamed)
from `RELO_ARTIFACTS_DIR` first, then the image's. Without them (every public image: the app is GPL and stays out of
the public export) the install script says the server has no Mac app.
