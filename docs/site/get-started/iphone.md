---
title: Add your iPhone
nav: 3. Add your iPhone
summary: The Relo app on your iPhone, signed in to your server, with notifications and Live Activities on.
---

## What you get

The place where everything lands: live cards on the Lock Screen, in the Dynamic Island and on your
Apple Watch, the **Now** and **History** tabs, and the answer buttons for every question. The phone
also holds the keys that open your content, so it is the one device that can read everything.

You build the app yourself in Xcode with your own Apple team, and give your server an Apple push key so
it can wake the phone.

## What you need

- **A Mac with Xcode,** to build the app.
- **An Apple Developer membership,** for your Team ID and the App IDs.
- **An Apple push key** (a `.p8` file), so your server can wake the phone.
- **Your server, reachable from the phone,** at an address the iPhone can open. A `localhost` address
  does not work.

## Build and install

<ol class="docs-steps">
<li>

**Set your signing values.** On the Mac, in your clone of the repository:

```sh title="On the Mac"
cp apps/ios/Config/Signing.local.xcconfig.example \
  apps/ios/Config/Signing.local.xcconfig
```

Edit `Signing.local.xcconfig`:

| Key | Example | What it is |
| --- | --- | --- |
| `DEVELOPMENT_TEAM` | `YOUR_TEAM_ID` | your Apple Developer Team ID |
| `RELO_BUNDLE_ID` | `com.example.relo.notifications` | a unique App ID; the extensions derive theirs from it |
| `RELO_APP_GROUP` | `group.com.example.relo.notifications` | the App Group shared by the app and its extensions |
| `RELO_API_ORIGIN` | `https:/$()/relo.example.com` | optional: pre-fills your server address (keep Xcode's `/$()/` escape) |

</li>
<li>

**Build and run.** Open `apps/ios/Relo.xcodeproj` in Xcode. Select the **Relo** scheme and your
connected iPhone, leave automatic signing on for all three targets (the app, the Notification Service
Extension and the Live Activity extension) and press **Run**. If Xcode cannot create the App ID, App
Group or profiles, add your account under **Xcode → Settings → Accounts**.

</li>
<li>

**Add your server and sign in.** On the iPhone, open Relo and tap **Add your server**. Enter the
address you open the Dashboard at (your `RELO_APP_URL`) and tap **Done**. Then tap **Sign in** with the
owner account you created in [step 1](/docs/get-started/server). Sign-in opens in the browser and comes
straight back to the app. (**Create account** is for a new account on a server that lets people join.)

</li>
<li>

**Allow notifications** when asked, and leave Live Activities on. The phone registers with the server
and creates its encryption keys.

</li>
<li>

**Approve computers.** The computer you connected in [step 2](/docs/get-started/cli) needs nothing from
you here: it joined before any phone, so it needs no approval. A computer you add from now on does,
unless this iPhone made its code: tap **Approve** on the request the phone shows.

</li>
<li>

**Add more computers when you want to.** If your account has no computer yet, the app opens **Connect a
computer** once, with the same one line. Later, **Settings → Devices → Add a computer** opens it again.
**Settings → Devices → Sign in a computer** approves a computer that ran `relo auth login`: scan its QR
code or type the code, and pick the number the terminal shows. See
[Connect a computer](/docs/guides/servers).

</li>
</ol>

## Turn on push delivery

Until the server has an Apple push key, the app syncs only while it is open. To let the server wake
the phone and update Live Activities:

<ol class="docs-steps">
<li>

**Copy the key** into the protected secrets folder on the server:

```sh title="On the server"
cp /path/to/AuthKey_KEYID.p8 deploy/secrets/apns_key.p8
chmod 600 deploy/secrets/apns_key.p8
```

</li>
<li>

**Describe the key** in `deploy/.env`, leaving `APNS_MODE=disabled` for now. Copy the values from the
key's record in your Apple Developer account; do not guess them from the file.

```dotenv
APNS_MODE=disabled
APNS_TEAM_ID=YOUR_10_CHARACTER_TEAM_ID
APNS_KEY_ID=YOUR_10_CHARACTER_KEY_ID
APNS_TOPIC=com.example.relo.notifications
APNS_KEY_SCOPE=team-scoped
APNS_KEY_ENVIRONMENT=sandbox
APNS_DUAL_ENVIRONMENT_CONFIRMED=false
APNS_ASSOCIATED_TOPICS=
APNS_CONFIGURATION_GENERATION=initial
APNS_CUTOVER_AT=2026-01-01T09:00:00Z
```

`APNS_TOPIC` must equal your `RELO_BUNDLE_ID`. A build run from Xcode gets sandbox push tokens, so use
`sandbox`. Set `APNS_CUTOVER_AT` to the current UTC time (`date -u +"%Y-%m-%dT%H:%M:%SZ"`); it must not
be in the future. A topic-specific key takes `APNS_KEY_SCOPE=topic-specific` and its exact
comma-separated topics in `APNS_ASSOCIATED_TOPICS`.

</li>
<li>

**Record the cutover and switch it on.** Stop the worker, record the cutover, then change
`APNS_MODE=disabled` to `APNS_MODE=sandbox` and start the worker again:

```sh title="On the server"
docker compose --env-file deploy/.env -f deploy/compose.yaml stop worker
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm worker \
  node dist/apns-operations-cli.js cutover
# now set APNS_MODE=sandbox in deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d worker
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

</li>
</ol>

:::note Never put the key on the phone
The `.p8` key lives only on the server. Do not copy it into the Xcode project or onto the iPhone.
:::

## Check it

In the Dashboard, your iPhone appears under **Connections → Phones**, and the app's **Now** tab loads without a
notice asking you to allow notifications. On the server, `docker compose ps` keeps showing the worker
as running. On your computer:

```sh
relo doctor
```

`next.step` is now `test`: the server and your phone are known, and the last check is a real card on
the phone. That is the next step.
