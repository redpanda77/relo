# Relo for Mac, as this server hands it out

`pnpm deploy:prod` fills this folder on the owner's Mac before the image is built:
`scripts/release/build-mac-app.sh` builds Relo for Mac (`apps/notch`), signs it with Developer ID, notarizes it and
writes `relo-mac.zip` with `manifest.json` (`version`, `sha256`, `app`, `executable`). The image copies the folder;
the server serves the zip at `/mac/relo-mac.zip`, and `install.sh --mac-app` installs it. Without them (every public
image: the app is GPL and stays out of the public export) the install script says the server has no Mac app.
