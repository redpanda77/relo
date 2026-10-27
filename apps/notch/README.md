# Relo for Mac

Relo in the Mac's notch: what runs, what needs you and what just finished, at the top of the screen.
The closed notch carries the focus card (a ring in Relo's colors and a count); hovering opens
the Relo tab with every live card, and approvals, yes/no and choice questions can be answered there.

It is a fork of [boring.notch](https://github.com/TheBoredTeam/boring.notch) (upstream commit
`64b5459`), cut down to three things:

- **Relo**: the closed-notch card, the Relo tab with live cards and answers, a state-aware menu bar
  icon, and a Relo tab in Settings for the account and what the closed notch shows;
- **Music**: the player, visualizer, lyrics and the Apple Music, Spotify, YouTube Music and Now
  Playing sources, with the music sneak peek;
- **Shelf**: drop files on the notch to keep them, AirDrop and the other sharing services.

boring.notch's HUD replacement, battery, calendar, face, downloads and tips are gone, and its updater is
replaced by Sparkle updates from this repository.

## Two modes

- **Relo on this Mac (local mode).** The app runs Relo on this Mac with no server to run, no account, no
  iPhone and no encryption: nothing leaves the Mac. `ReloNotchKit`'s `LocalServer.swift` runs the Relo
  service the app carries, and its `LocalMode.swift` holds the words the notch uses in this mode (none about
  an account, a server address, an iPhone or encryption). This is what the Download for
  Mac button on a Relo server's home page installs.
- **Another Relo server.** The app connects to a server you run, as an owner device, described next.

## How it talks to a server

`ReloNotchKit/` is the Relo client. It reuses the iPhone's Swift modules (`apps/ios`: ReloCore,
ReloTransport, ReloRuntime, ReloPersistence, ReloNotificationSupport), so the Mac is an owner device
exactly like a phone:

- sign-in through `/mobile/sign-in` (PKCE, system web sheet), then `POST /api/devices/register`;
- this Mac's encryption keys are published, which asks the account's iPhone to approve it; until then
  private text reads "Private work";
- `GET /api/now` is the only state it shows (the server's derivation), refetched on the
  `/api/inbox/events` change stream, every 60 s and at `refreshAt`;
- answers are signed with this Mac's identity key and sent like the iPhone's.

## Build

```bash
cp Configuration/Relo.local.xcconfig.example Configuration/Relo.local.xcconfig   # team, bundle id, server
xcodebuild -project boringNotch.xcodeproj -scheme boringNotch -configuration Debug -allowProvisioningUpdates build
```

To try a change on this Mac, `scripts/notch-dev.sh` builds Debug incrementally (7 to 15 s for a view or a sound), quits the running
Relo and opens the build (`--test` runs ReloNotchKit's tests first). No gates, no server, no version bump: a release
(`pnpm deploy:prod`) ships a change to every Mac and takes along every other change on main. A release with only
notch changes skips the server, signs as the last export did, and installs the new app on the Mac that released it
(`RELO_DEPLOY_INSTALL_MAC=0` leaves that to Sparkle's hourly check).

Signing with a team is required: the Keychain and Secure Enclave hold this Mac's credential and keys.
`cd ReloNotchKit && swift test` runs the client tests. A Debug build renders the Relo views from the
contract fixture with `--relo-snapshot < apps/ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json`.

Release build: `scripts/release/build-mac-app.sh [OUT_DIR]`. Every long command runs through
`scripts/step.mjs` with a budget (the archive: 15 min, 5 min without output, background priority, one heavy
step at a time; `sign_update`: 30 s without output), so a hidden prompt stops the build instead of hanging it.
Derived data is fixed at `~/Library/Caches/relo/notch-derived-data` (`RELO_MAC_DERIVED_DATA`), so a fresh clone
reuses earlier compilation. Update signing reads `~/.config/relo/sparkle/ed25519.key`
(`RELO_SPARKLE_KEY_FILE`), never the keychain: `node scripts/release/sparkle-key.mjs init` creates it and prints the
public key for `RELO_SPARKLE_PUBLIC_KEY` in `Relo.local.xcconfig`; without the file the build ships unsigned for updates.

## License

GPL-3.0, as boring.notch (see `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES`). This directory is a
separate program from the rest of the repository, which is PolyForm Noncommercial; it is kept out of the
public export until the license of the Relo modules it links is settled.

## Building from the public source

The public repository carries this app's full source. One piece is not in it: the prebuilt
`mediaremote-adapter/MediaRemoteAdapter.framework` (MediaRemoteAdapter, Copyright (c) 2025 Jonas van den Berg
and contributors, BSD 3-Clause; see `THIRD_PARTY_LICENSES`). Download it from the upstream project's release
and put it in `mediaremote-adapter/` before building. The signed builds Relo hands out include it.
