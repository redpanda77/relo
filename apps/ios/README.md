# Relo Notifications for iPhone

This is the native SwiftUI client for Relo. The committed `Relo.xcodeproj` opens and builds directly in Xcode; installing XcodeGen is not required to run the app.

## What is implemented

- Three tabs: **Now**, **History** and **Settings**.
- **Now** opens with the deck (needs you, waiting, running, sessions) and then the lists: Needs you,
  Waiting on you, Running, Quiet, Paused, Sessions and Today. It reads `GET /api/now`, which also
  carries the phone's own sealed card and question envelopes.
- **Sessions** are grouped by computer. A row shows the session's name (sealed by the CLI's Claude Code
  hook; otherwise source and project), its work and its phase: working, needs your input or your turn
  (`waitingFor`), idle, ended, or "last seen" from `lastSeenAt`. Idle sessions fold.
- Plans read "Step N · K to go · <step>" (plus "d of t" for a counted step) on the Live Activity and
  on the detail timeline while the work runs.
- A missed question in Needs you offers **Answer late** (never permission; the session must ask again)
  and **Dismiss**. A refused Dismiss means the row was already stale: it stays gone and Now refetches.
- Browser sign-in: **Sign in** opens the server's `/mobile/sign-in` page in
  `ASWebAuthenticationSession`; the owner approves there and the app exchanges a one-time code
  (authorization code + PKCE) at `POST /api/mobile/sign-in/token` for its account session. The server
  origin is chosen on the onboarding **Your server** card or the sign-in **Server** section.
- End-to-end encryption (`relo.e2e.v1`): the identity key lives in the Secure Enclave, and the app,
  Notification Service Extension and Live Activity widget open sealed notices, questions, cards and
  session names on the phone. History and the activity detail never show a placeholder title: they
  use the opened text, the question's first line, or "Can't be read on this iPhone". Answers are
  signed. **Settings → Devices** approves new phones and computers (Face ID or passcode) and links a
  browser by scanning its QR code.
- Keychain-only account sessions, device credentials, stable device/installation IDs, APNs token, and registration retry state using `AfterFirstUnlockThisDeviceOnly`.
- Automatic, idempotent device creation and refresh through `POST /api/devices/register` against
  the configured server origin.
- Two-credential sign-out: device revocation and Better Auth session revocation must both succeed before local protected data is erased.
- Notification authorization and APNs registration handoff.
- Server-authoritative History with an account-scoped protected offline projection, **Load older
  notifications** paging, and a local **Keep history** window (1 day to everything; it only hides items
  on this phone, never pending requests) with **Clear history**.
- Durable cursor synchronization that commits each page before advancing, deduplicates by event ID, and performs a full rebuild after a server cursor reset.
- Honest APNs states: `accepted_by_apns` is shown as **Accepted by Apple**, never as confirmed delivery.
- Notification Service Extension: opens sealed alerts, attaches images only from the cache (public
  HTTPS checked, never downloaded), adds communication-style metadata, and records receipts in an
  atomically locked shared-container queue that tolerates concurrent app/extension writers.
- Durable notification tap routing with cold-open settling; approval, yes/no and choice answers from
  notifications (authentication required) and from the Live Activity through one App Intent; fail-closed
  retry queues.
- App-icon badge from the server's actionable count, applied only when that data is current. A missed
  question counts until the server retires it.
- One content-driven Live Activity layout for the Lock Screen, the compact, minimal and expanded Dynamic
  Island, and the Apple Watch Smart Stack.
- Origin-neutral connection messages: "Can't reach your Relo server" and "Server unreachable" name no
  network or address.
- One-file signing defaults, runtime origin persistence, automatic signing, gradient/glass app
  icon, and required platform manifests.

## Account and offline behavior

The website and iPhone use the same Relo account. iOS sends the Better Auth mobile session only to account-session, account and device-registration routes. Now, Inbox, heartbeat, and interaction traffic use the separately revocable device credential.

A push is only a wake-up hint. The Relo server owns the canonical state. If the phone is offline, cached Now and History remain visible. On return, the app reads `GET /api/now` and the authoritative current state (`GET /api/inbox/current`, with `GET /api/inbox/events` change hints while connected) and repairs its protected history from `GET /api/inbox/snapshot`; a missed hint is recovered by the next read. The Now cache keeps sealed bytes only.

The protected offline projection keeps the newest 250 items per account. While connected, History uses `GET /api/inbox/history?before=<cursor>&limit=100` as a separate in-memory browsing window so **Load older notifications** can traverse arbitrary-age history without growing the offline cache. Account-session, device, or credential-version changes replace that browsing window rather than merging it across scopes.

Caches are scoped by Relo `accountId`. A different account never opens or merges another account's
history. Retired unscoped cache and credential shapes are discarded; they are never adopted into
the current account.

Pending interactive responses remain fail-closed: a local tap is never approval until the Relo server commits it.

## Install on the connected iPhone

### Prerequisites

1. An active Apple Developer Program team with Push Notifications access.
2. Xcode signed into that account and the iPhone trusted with Developer Mode enabled.
3. An Apple APNs `.p8` key, Key ID, and Team ID installed only on the Relo server. Never copy the `.p8` into this project or onto the iPhone.
4. An iPhone that can reach the configured Relo server origin.
5. A Relo account created through that server's Dashboard.
6. The matching iOS platform support installed in Xcode.

Copy `Config/Signing.local.xcconfig.example` to the Git-ignored `Config/Signing.local.xcconfig` and provide the values for your Apple team and server. If automatic signing cannot create profiles, add the matching account in **Xcode → Settings → Accounts**.

Apple's [Communication Notifications guidance](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications) places the capability on the parent `Relo` app target. The Notification Service Extension uses the parent app's communication-notification authorization while modifying content and must keep only its App Group entitlement. If Xcode reports that `com.apple.developer.usernotifications.communication` cannot be included in the extension profile, regenerate the project from `project.yml` and confirm the capability was not manually added to `ReloNotificationService`.

### Run

1. Open `Relo.xcodeproj` directly. Do not regenerate it just to run the app.
2. Select the **Relo** scheme and connected iPhone.
3. Leave automatic signing enabled for the app, Notification Service Extension, and Live Activity extension.
4. Press **Run**.
5. On the iPhone, open Relo, enter your server's address and tap **Sign in**. Approve in the browser, and you're back in the app.
6. Allow notifications and Live Activities when prompted. The app registers immediately and refreshes the same device automatically when Apple supplies or rotates the APNs token.
7. Confirm the Dashboard lists this iPhone under Connections, then run `relo test` from a signed-in computer.

The app is ready only after account authentication, device registration, notification authorization, and a successful sync. APNs acceptance is displayed as **Accepted by Apple**, not as proof iOS presented the notification. Without the server's Apple `.p8` credentials the app cannot be woken remotely; it still syncs while open.

## Signing and origin configuration

Keep portable defaults in `Config/Signing.xcconfig`. Put deployment-specific signing/origin values only in the ignored `Config/Signing.local.xcconfig`:

| Key | Example | Requirement |
| --- | --- | --- |
| `DEVELOPMENT_TEAM` | `YOUR_TEAM_ID` | Apple Developer Team used for every target |
| `RELO_BUNDLE_ID` | `com.example.relo.notifications` | Globally unique main App ID; extension IDs derive from it |
| `RELO_APP_GROUP` | `group.com.example.relo.notifications` | App Group enabled for the app and both extensions |
| `RELO_API_ORIGIN` | `https://relo.example.com` | Exact reachable origin; no trailing slash |

`Config/Signing.xcconfig` also sets `RELO_GIT_COMMIT` (`uncommitted` unless `Scripts/build-authoritative.sh` stamps the source commit). The extensions resolve to `<RELO_BUNDLE_ID>.service` and `<RELO_BUNDLE_ID>.activities`; the reference host uses `<RELO_BUNDLE_ID>.reference`. If the bundle ID changes, Relo server's `APNS_TOPIC` must exactly match the main bundle ID.

Direct Xcode Debug builds receive sandbox APNs tokens, so the server must use `APNS_MODE=sandbox`. The app permits HTTP only for local server addresses and rejects public plaintext origins.

## Mobile API integration

Every request carries `Authorization: Bearer` with the credential below, except the code exchange and
Live Activity responses, which carry their proof in the body.

Sign-in (no bearer):

- `GET /mobile/sign-in` (browser), then `POST /api/mobile/sign-in/token`

Account bearer session:

- `GET /api/auth/get-session`
- `POST /api/devices/register`
- `GET /api/account/deliveries/status`
- `POST /api/account/notifications/:notificationId/withdraw`
- `POST /api/auth/sign-out`
- `POST /api/account/delete`

Device bearer credential:

- `GET /api/devices/self`, `PUT /api/devices/:deviceId`, `DELETE /api/devices/:deviceId`
- `GET /api/now`
- `PUT /api/devices/self/live-activities/:activityId/token`
- `POST /api/devices/self/live-activities/:activityId/dismissed`
- `POST /api/devices/self/questions/:questionId/dismiss`
- `GET /api/inbox/current`, `GET /api/inbox/events`, `GET /api/inbox/pending`
- `GET /api/inbox/snapshot`, `GET /api/inbox/history?before=<cursor>&limit=100`, `GET /api/inbox/:notificationId`
- `POST /api/inbox/read-items`
- `GET /api/inbox/live-activities/active`
- `POST /api/notifications/:notificationId/interactions`
- Encryption: `PUT /api/devices/self/keys`, `GET /api/clients/keys`, `GET /api/devices/self/pending-devices`,
  `POST /api/devices/self/approvals`, `POST /api/devices/self/approvals/:deviceId/decline`,
  `GET /api/devices/self/devices`, `GET|POST /api/devices/self/links`, `DELETE /api/devices/self/links/:browserId`

Device-bound Live Activity response capability:

- `POST /api/live-activity-responses/:interactionId`

Passwords, account sessions, device credentials, and APNs tokens are never logged, rendered, placed in URLs, or stored in `UserDefaults`.

## Developer verification

The Live Activity extension draws one content-driven layout for the Lock Screen, the compact,
minimal and expanded Dynamic Island, and the Apple Watch Smart Stack (iOS 18). Dynamic Island
projections do not reuse Lock Screen copy verbatim: camera-adjacent regions show compact identity and
progress, while the full status stays in the wider expanded body. Content fits a 110-point budget on
the Lock Screen and 84 points in the Island, and a question always keeps its answer buttons.

References: [Apple Live Activities HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities),
[displaying live data](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities),
and [WidgetKit view construction](https://developer.apple.com/documentation/widgetkit/creating-views-for-widgets-live-activities-and-watch-complications).

```sh
cd apps/ios
swift test
xcodebuild -project Relo.xcodeproj \
  -scheme Relo \
  -configuration Debug \
  -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=NO build
```

`project.yml` is the maintainers' source of truth. Run `xcodegen generate` after changing the project specification or adding source/test files, and include the regenerated `.xcodeproj` in the same change.

Media loading geometry has a native macOS SwiftUI regression harness. It compiles the actual
media viewport and status label views, reproduces the previous 120-to-240-point image
height jump, and checks unchanged bounds across loading, failure, loaded media, connection
status, widths, and text sizes. It does not install or run the iOS app:

```sh
cd apps/ios
swiftc -parse-as-library Scripts/verify-home-loading-layout.swift \
  Sources/ReloApp/ReloMediaViewport.swift Sources/ReloApp/ReloNowStatusLabel.swift \
  -o /tmp/relo-verify-home-loading-layout
/tmp/relo-verify-home-loading-layout
```
