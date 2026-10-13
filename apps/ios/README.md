# Relo Notifications for iPhone

This is the native SwiftUI client for Relo. The committed `Relo.xcodeproj` opens and builds directly in Xcode; installing XcodeGen is not required to run the app.

## What is implemented

- Browser sign-in: **Sign in** opens the server's `/mobile/sign-in` page in
  `ASWebAuthenticationSession`; the owner approves there and the app exchanges a one-time code
  (authorization code + PKCE) for its account session. The server origin is persisted and can be
  changed under **Use another server**.
- A clear **Open Relo Dashboard** action at the configured origin plus `/dashboard`.
- Keychain-only account sessions, device credentials, stable device/installation IDs, APNs token, and registration retry state using `AfterFirstUnlockThisDeviceOnly`.
- Automatic, idempotent device creation and refresh through `POST /api/devices/register` against
  the configured server origin.
- Two-credential sign-out: device revocation and Better Auth session revocation must both succeed before local protected data is erased.
- Notification authorization and APNs registration handoff.
- Server-authoritative Recent Activity with an account-scoped protected JSON projection for instant offline display.
- Durable cursor synchronization that commits each page before advancing, deduplicates by event ID, and performs a full rebuild after a server cursor reset.
- Attached HTTPS link indicators in every Inbox row, with an explicit open action in notification detail.
- Backward history pagination through `GET /api/inbox/history`, with an authoritative device-visible total, explicit loaded/search bounds, and safe page-one replacement after an expired opaque cursor.
- Honest APNs states: `accepted_by_apns` is shown as **Accepted by Apple**, never as confirmed delivery.
- Notification Service Extension with bounded public-HTTPS image attachments, communication-style metadata, and an atomically locked shared-container receipt queue that tolerates concurrent app/extension writers.
- Durable notification tap routing with cold-open settling, ordinary approval/yes-no/text responses, device-bound Live Activity approval/yes-no App Intents, and fail-closed retry queues.
- App-icon badge count derived from unanswered, unexpired interactions rather than total history. Ordinary APNs delivery carries Relo server's current device-specific pending count; app launch, foregrounding, response, and Inbox synchronization reconcile it from canonical state. An expiry that occurs without any device wake is reflected on the next push or sync rather than by a guaranteed background timer.
- Nine distinct ActivityKit/WidgetKit Live Activity compositions across the Lock Screen and expanded Dynamic Island.
- Device-targeted dashboard previews that start only after a fresh Inbox sync, deduplicate active instances, and expire after ten minutes to prevent historical replay.
- One-file signing defaults, runtime origin persistence, automatic signing, gradient/glass app
  icon, and required platform manifests.

## Account and offline behavior

The website and iPhone use the same Relo account. iOS sends the Better Auth mobile session only to account-session and device-registration routes. Inbox, heartbeat, and interaction traffic continues using the separately revocable device credential.

A push is only a wake-up hint. The Relo server owns the canonical Inbox. If the phone is offline, cached activity remains visible. On return, the app reads authoritative current state (`GET /api/inbox/current`, with `GET /api/inbox/events` change hints while connected) and repairs its protected history from `GET /api/inbox/snapshot`; a missed hint is recovered by the next read.

The protected offline projection keeps the newest 250 items per account. While connected, Recent Activity uses `GET /api/inbox/history?before=<cursor>&limit=100` as a separate in-memory browsing window so **Load older** can traverse arbitrary-age history without growing the offline cache. Search and filter copy states exactly how many items are loaded and the current server-reported total. Account-session, device, or credential-version changes replace that browsing window rather than merging it across scopes.

Caches are scoped by Relo `accountId`. A different account never opens or merges another account's
history. Retired unscoped cache and credential shapes are discarded; they are never adopted into
the current account.

Pending interactive responses remain fail-closed: a local tap is never approval until the Relo server commits it. The account-auth migration does not change the device-bound response credential model.

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
5. On the iPhone, open Relo and tap **Sign in**. Approve in the browser, and you're back in the app.
6. Allow notifications when prompted. The app registers immediately and refreshes the same device automatically when Apple supplies or rotates the APNs token.
7. Confirm the dashboard lists this iPhone, then send a test notification.
8. In **Live Activity Gallery**, choose the iPhone and press any style. Open the app and tap **Refresh** to start that preview.

The app is ready only after account authentication, device registration, notification authorization, and a successful Inbox round trip. APNs acceptance is displayed as **Accepted by Apple**, not as proof iOS presented the notification.

The dashboard preview path does not require an APNs provider key: it is synchronized from the durable Inbox while the app is foregrounded. Until the server has the Apple `.p8` credentials, the app cannot be remotely awakened, so open Relo and tap **Refresh** within ten minutes of pressing a gallery button.

## Signing and origin configuration

Keep portable defaults in `Config/Signing.xcconfig`. Put deployment-specific signing/origin values only in the ignored `Config/Signing.local.xcconfig`:

| Key | Example | Requirement |
| --- | --- | --- |
| `DEVELOPMENT_TEAM` | `YOUR_TEAM_ID` | Apple Developer Team used for all three targets |
| `RELO_BUNDLE_ID` | `com.example.relo.notifications` | Globally unique main App ID; extension IDs derive from it |
| `RELO_APP_GROUP` | `group.com.example.relo.notifications` | App Group enabled for the app and both extensions |
| `RELO_API_ORIGIN` | `https://relo.example.com` | Exact reachable origin; no trailing slash |

The extensions resolve to `<RELO_BUNDLE_ID>.service` and `<RELO_BUNDLE_ID>.activities`. If the bundle ID changes, Relo server's `APNS_TOPIC` must exactly match the main bundle ID.

Direct Xcode Debug builds receive sandbox APNs tokens, so the server must use `APNS_MODE=sandbox`. The app permits HTTP only for local server addresses and rejects public plaintext origins.

## Mobile API integration

Account bearer session:

- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/devices/register`
- `POST /api/auth/sign-out`
- `POST /api/account/delete`

Device bearer credential:

- `GET /api/devices/self`
- `PUT /api/devices/:deviceId`
- `PUT /api/devices/self/live-activities/:activityId/token`
- `DELETE /api/devices/:deviceId`
- `GET /api/inbox/current`, `GET /api/inbox/events`, `GET /api/inbox/pending`
- `GET /api/inbox/snapshot`, `GET /api/inbox/history?before=<cursor>&limit=100`, `GET /api/inbox/:notificationId`
- `POST /api/inbox/read-items`
- `GET /api/inbox/live-activities/active`
- `POST /api/notifications/:notificationId/interactions`

Device-bound Live Activity response capability:

- `POST /api/live-activity-responses/:interactionId`

Passwords, account sessions, device credentials, and APNs tokens are never logged, rendered, placed in URLs, or stored in `UserDefaults`.

## Developer verification

The Live Activity extension defines native Lock Screen plus compact, minimal, and expanded Dynamic
Island surfaces for all nine Relo styles. Dynamic Island projections do not reuse Lock Screen copy
verbatim: camera-adjacent regions show compact identity and progress, while full server-driven
status stays in the wider expanded body. Expanded content respects WidgetKit content margins, can
move below the camera when too wide, and stays within Apple's 160-point expanded-height guidance.
Validate both 371- and 408-point expanded widths and the 230- and 250-point compact widths.

References: [Apple Live Activities HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities),
[displaying live data](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities),
and [WidgetKit view construction](https://developer.apple.com/documentation/widgetkit/creating-views-for-widgets-live-activities-and-watch-complications).

The dashboard gallery depicts both the Lock Screen/expanded card and compact notch presentation.
When a fresh foreground-sync gallery command has no APNs-accepted delivery, the app also schedules
an ordinary local companion notification; it does not synthesize a haptic-only substitute.

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

Home loading geometry has a native macOS SwiftUI regression harness. It compiles the actual
media viewport and toolbar status views, reproduces the previous 120-to-240-point image
height jump, and checks unchanged bounds across loading, failure, loaded media, connection
status, widths, and text sizes. It does not install or run the iOS app:

```sh
cd apps/ios
swiftc -parse-as-library Scripts/verify-home-loading-layout.swift \
  Sources/ReloApp/ReloMediaViewport.swift Sources/ReloApp/ReloNowStatusLabel.swift \
  -o /tmp/relo-verify-home-loading-layout
/tmp/relo-verify-home-loading-layout
```
