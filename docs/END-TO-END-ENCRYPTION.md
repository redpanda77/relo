# End-to-end encrypted content

Status: **in progress.** [ADR 0005](adr/0005-end-to-end-encrypted-content.md) records the decision.
The table under [Delivery plan](#delivery-plan) is the current truth for what ships.

## Goal

What an agent tells you through Relo is readable only on the computers and iPhones you paired. The
Relo server, its database, its backups, the person who runs it, and Apple's push service carry
that content without being able to read it. They also cannot forge it, and cannot forge your
answer to a question. Content on the server can expire after a short window
(`RELO_CONTENT_RETENTION_HOURS`; 10 hours is the recommended value).
Once a phone has rotated past the key that sealed a message, no copy of that message anywhere can
be decrypted again, including copies made before the purge.

## Where Relo starts from (October 2026)

- The full notification body is sealed at rest with AES-256-GCM
  (`apps/server/src/notification-content.ts`). Device push tokens and callback tokens are sealed
  too (`apps/server/src/token-encryption.ts`).
- The key for both comes from one server secret, `BETTER_AUTH_SECRET`. Anyone holding the database
  and that secret can read every body. Titles, summaries, previews, questions, replies, Live
  Activity text, step labels, and project and topic names are stored as plaintext.
- ADR 0004 says the server admin cannot read another account. Today that holds only in the
  application. It is not cryptographic.
- Notification history is pruned only when an operator runs `pnpm notification-retention`. Live
  Activity rows and project names are never pruned.

This program closes the gap between "the application won't show it" and "the server cannot read
it".

## Threat model

| Adversary | After this program |
| --- | --- |
| Someone with a database dump or backup, or a stolen disk | Sees ciphertext and metadata. Expired content is gone. Older ciphertext is undecryptable once the phone rotates its keys. |
| The server operator or admin, including a malicious one with full control of the code it runs | Cannot read content and cannot forge content or answers. Can still see metadata, delay or drop messages, and deny service. A phone the server adds after the first one is recorded as *pending*: the CLI does not seal to it and refuses its answers until a phone the computer already trusts approves it (a signed, end-to-end encrypted yes/no question) or a person runs `relo keys verify`. Once a computer trusts a phone, it never falls back to readable text: if it cannot seal, the command fails (`E2EE_UNAVAILABLE`). |
| Apple Push Notification service | Sees ciphertext, the device token, size and timing. |
| Another account on the same server | No access, as today (ADR 0004). Encryption now backs this up. |
| An attacker on the network | TLS, as today. |
| An unlocked, compromised iPhone or computer | **Out of scope.** An endpoint has to read the content to show it. |

The server always sees this metadata:

- which account, device and CLI key is involved
- when something was sent, and the size bucket of each envelope
- the kind of message (notice, question or card)
- the state machine: active, ended, approved or denied, expired
- opaque project and topic handles
- delivery timing

Message sizes are padded to buckets. Timing is not hidden.

### Content that cannot be end-to-end encrypted

- **Webhooks and other services that hold no Relo key.** These stay server-sealed, as today, and
  the phone labels them *Not end-to-end encrypted*.
- **Messages the server writes itself.** This covers account-request notices, the "Relo needs you"
  fallback, and the Test Lab. They are labelled the same way.
- **The web Dashboard.** The server delivers the Dashboard's JavaScript, so a malicious server
  could deliver code that reads keys. The Dashboard therefore stays metadata-only for
  end-to-end-encrypted items: it shows a lock and tells you to open the item on the iPhone.
  Encrypted items cannot be read in a browser by design.

## Design

### Cryptography

These are standard primitives only, with no Relo-specific crypto:

- **HPKE (RFC 9180)**, using DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM.
  - P-256 is the curve the iPhone's Secure Enclave supports.
  - CryptoKit provides HPKE on iOS 17 and later. Relo's minimum is iOS 17.2.
  - The CLI implements RFC 9180 base mode on `node:crypto` primitives (`packages/cli/src/e2ee.mjs`),
    so it keeps zero dependencies; the shared test vectors prove it matches CryptoKit.
- **ECDSA P-256 (SHA-256)** for signatures.
- Content is encrypted once with a random 256-bit key using AES-256-GCM. That key is then wrapped
  with HPKE separately for each recipient device. Associated data (AAD) binds the body to the
  version, kind, `context` and sender key id, and each wrapped key additionally to its device and
  prekey. `context` is a value the CLI chooses for each message (for a notice, a hash of its
  idempotency key), so the server cannot move an envelope to another message without the phone
  noticing; the phone's replay ledger refuses a context seen under another notification.
- Cross-implementation test vectors live in `packages/contracts/fixtures/e2ee-v1/`. CryptoKit and
  Node each seal and open the other's vectors.

### Keys

| Key | Where it lives | Lifetime | Purpose |
| --- | --- | --- | --- |
| Device identity key (ECDSA P-256) | iPhone Secure Enclave, in a Keychain access group shared by the app and both extensions | The life of the install | Signs prekeys and answers. Cross-signs new devices. |
| Device prekey (P-256 key agreement) | The shared Keychain group of the app and its extensions, readable after the first unlock and never leaving the device (`AfterFirstUnlockThisDeviceOnly`). A CryptoKit Secure Enclave key works only in the process that created it, so the Lock Screen widget and the notification extension could not open content with one. | Replaced every `rotation` (10 h by default). The private half is deleted after `retention + grace` | Receives sealed content |
| CLI identity key (ECDSA P-256) | CLI config directory, file mode 0600. The macOS Keychain later. | The life of the login. `relo keys rotate` replaces it. | Signs every envelope the CLI sends |
| Per-question reply key (P-256 key agreement) | CLI state directory, deleted when the question resolves | One question | The phone seals a typed reply to it, so each reply has its own forward secrecy |
| Account grouping key (256-bit) | Created by the first paired iPhone and sealed to each CLI when it is verified | Long-lived; rotating it regroups projects | Turns project and topic names into opaque handles the server can group by |

The phone publishes `{prekeyId, publicKey, createdAt, signature-by-identity}`. The server stores
public halves only.

### Trust: automatic, like WhatsApp and Signal

Nobody has to compare keys for encryption to work. A computer trusts a phone's identity key the first
time it sees it, and a phone trusts a computer's key the first time it sees it (trust on first use).
Sealing and signed approvals start at once.

- **A key change** (a reinstall, a new phone, `relo keys rotate`) is trusted again automatically and
  keeps working. It leaves a visible, non-blocking notice: "security code changed" in
  `relo keys status` and on the phone's Settings → Security.
- **A new phone is approved on a phone you already have.** The first phone is trusted on first use.
  A phone that appears later stays *pending* until a trusted phone approves it in Settings → Security
  (see "New devices are approved on a trusted phone" below); the server cannot add a phone of its own.
- **A new computer is approved on the phone.** The computers already on the account when the phone
  signs in are trusted on first use. A computer that appears later is *pending* on the phone: the
  phones get a "New computer wants access" notification, and nothing it sends opens until the owner
  approves it in Settings → Security (Decline keeps it closed). So someone with the account password
  cannot add a computer whose messages and questions the phone believes.
- **A phone set up again is trusted again, like WhatsApp after a reinstall.** Signing out keeps the
  phone's own keys, so the same phone signing in again is recognised by its key with no notice.
  When every phone a computer trusted has left the account, the account's new phone is trusted
  automatically and every command shows "your phone was set up again" for a week. The trade-off is
  WhatsApp's: a server that removes your phone and adds its own gets that visible notice, not a block.
  So does anyone with the account password, who can sign the phone out from the Dashboard. In strict
  mode the new phone stays pending until `relo keys verify`.
- **Verifying is optional.** `relo keys verify` and Settings → Security → Verify security code show
  the same 60-digit number, derived from the two identity keys like Signal's safety numbers.
  Confirming that they match upgrades the pairing to "verified".
- **Strict mode is optional.** `relo keys strict on` (a person at a terminal) stops sealing to a phone
  whose security code changed, and to a phone set up again after every trusted phone left, until it
  is verified. [HARDENING.md](HARDENING.md) recommends it for a server on a public address.

The trade-off is the usual one for trust on first use. A server that is malicious *at the moment a
device is first seen* could present its own key. Against that, every later substitution shows up as
a security code change. People who want more can verify once, or use strict mode.

### Envelope

```json
{
  "v": "relo.e2e.v1",
  "kind": "notice | question | card | card-update | reply | grouping-key",
  "context": "ntf:…",
  "sender": "k_…",
  "recipients": [ { "device": "dev_…", "prekey": "pk_…", "enc": "…", "key": "…" } ],
  "nonce": "…",
  "ct": "…",
  "sig": "…"
}
```

`sig` is the sender identity's ECDSA signature over every other field. The plaintext is padded to
256-byte blocks before encryption.

The sealed plaintext is one JSON object containing every user-text field of that kind. For
example, a notice holds title, summary, body and context labels. A card holds title, status, step
labels, next step and button labels.

When the server pushes to a device, it includes only that device's recipient entry, which keeps
APNs payloads well under 4 KB.

### What the server still needs, sent as metadata

The server currently reads content to make decisions. Each of those decisions moves into explicit
fields that the CLI computes from plaintext before sealing:

| Server behaviour today | Under end-to-end encryption |
| --- | --- |
| Regex on status text picks tone, icon and state (`presentation-policy.ts`) | The CLI sends `tone` and `state` enums. The regex moves into `packages/contracts`, shared with the CLI. |
| Project and topic names become keys, aliases and conversations | The CLI sends `projectRef` / `topicRef` = HMAC(grouping key, normalized name). Renames and aliases are done on the phone. |
| Thread ids and presentation-lease scopes come from lowercased titles | Derived from the refs above |
| Idempotency hash covers plaintext | The CLI sends `contentDigest` = HMAC(grouping key, canonical plaintext). Retries reuse the stored envelope. |
| Previews and length checks: SQL `left()`, the 240/720-byte summary, zod lengths | The CLI validates lengths before sealing. The server checks envelope size bounds only. |
| The server writes text such as "Approved · …", "Expired", "Session ended", "Needs you" | The server sends enums. The phone renders the words. |
| The APNs alert shows title and body | The alert carries a fixed placeholder plus the sealed entry. The Notification Service Extension decrypts and replaces the text before it is shown. |
| Account color is a hash of the project name | Hash of `projectRef` |

### Answers that the server cannot forge

- An approval, denial, yes or no is signed by the device identity key over `{interactionId,
  notificationId, deviceId, value, respondedAt}`. For a sealed question the phone also signs the
  same fields plus the `context` of the envelope it opened (`relo.e2e.v1 answer-to`), and only when it
  actually opened that question. The CLI requires this second signature for a question it sealed,
  checks that it names the interaction it is waiting for and that it was made after the question was
  asked, so the server can neither replay an old approval nor show the phone a different question.
- The server stores the signature next to the state it already keeps, so cards and callbacks still
  work. The CLI accepts `approved` only when the signature verifies against a trusted device.
  `relo ask --approval` keeps its contract: exit 0 with state `approved`, now with a verified
  signature behind it.
- A typed reply is sealed to the question's one-time reply key. Callbacks receive the sealed reply.
- Live Activity buttons sign from the widget extension with the same identity key, through the
  shared access group.

### Live Activities

Live Activity content state is delivered by ActivityKit straight to the widget, with no extension
hook to decrypt it first. Route 1 is built (the widget opens the envelope with the App Group key
mirror described under Phone surfaces); route 2 is the documented alternative:

1. **Decrypt while rendering.** The widget's SwiftUI view opens the sealed `presentation` field
   with the prekey from the App Group mirror. This needs the decryption to fit the widget's memory
   and time budget on a locked device.
2. **Neutral content state.** Pushed content state carries only state, progress, tone and times.
   Text arrives sealed in a silent push or a sync, and the app re-applies it locally with
   `Activity.update`. On a cold Lock Screen the card shows generic labels until the app runs.

The interaction `credential` in content state is a server capability, not content, and stays as it
is.

### Retention and forward secrecy

- **Server.** Notification history, questions, replies and sealed bodies are deleted after
  `RELO_CONTENT_RETENTION_HOURS` (the recommended value is 10), with the same safeguards as the
  manual tool: pending questions, active cards and current relevance heads are never pruned.
  Ended cards, with their steps and snapshots, go once their events are gone (E1.2). Without the
  variable, content stays until an operator runs `pnpm notification-retention`.
- **Phone.** History lives on the phone, in file-protected caches, under the phone's own retention
  setting. Server history returns metadata, and the app fills in text from its cache. Text that
  has expired on both sides shows as *Expired*.
- **Prekeys.** The phone deletes a private prekey once `retention + 2 h` has passed since a newer
  prekey replaced it. This happens when the app or an extension next runs, and iOS does not
  guarantee when that is.
  - From that moment, every envelope sealed to that prekey is unreadable, including any copy
    taken before the purge.
  - If the phone has not run for a long time, the CLI keeps using the newest signed prekey. The
    server marks a prekey older than 7 days as stale, and `relo keys status` shows it as `stale`:
    the phone needs to be opened.

### Losing a phone

A new phone starts with empty history. That is intended: content was disposable and has expired.
The new phone is trusted through cross-signing from another verified device or through
safety-number verification on each CLI. Revoking the old device removes it from every recipient
list immediately.

### New devices are approved on a trusted phone

A phone (or iPad) that signs in after the account's first phone is *pending*: computers seal nothing
to it and refuse its answers. It is approved on a phone the computers already trust, never by
comparing keys, and the request is always visible until it is answered.

**Signing.** The trusted phone's identity key signs

```
relo.e2e.v1 approve-device
<deviceId of the new phone>
<its identity public key, b64u X9.63>
<approving phone deviceId>
<signedAt, ISO 8601>
```

**Server.**
- `GET /api/devices/self/pending-devices` (phone credential) → `{ devices: [{ deviceId, name, model?,
  registeredAt, keyId, identityKey }] }`: the account's other active phones with published keys that
  have no approval for their current identity key. It never lists the calling phone.
- `POST /api/devices/self/approvals` `{ deviceId, identityKey, signedAt, signature }` stores the
  approval (only for a device of the same account whose current identity key matches).
- `POST /api/devices/self/approvals/:deviceId/decline` revokes that device (signs it out).
- `GET /api/devices/keys` adds `approval: { deviceId, signedAt, signature } | null` to each phone.
- When a phone first publishes keys and the account already has another phone with keys, the server
  sends the other phones a plain notification "<model> wants to read your Relo cards" (for example
  "iPhone 17 Pro wants to read your Relo cards"; device name and time only, "Approve or decline it in
  Devices"), deep-linking to `relo://security/request/<dev_…>` with the APNs category
  `RELO_DEVICE_ACCESS`. The "New computer wants access" notice does the same with
  `relo://security/request/<key_…>`.
- `GET /api/devices/self/devices` (phone credential) → `{ devices: [{ deviceId, name, model,
  isSimulator, registeredAt, lastSeenAt, isCurrent, trusted }] }`: the account's active phones, where
  `trusted` means the account's first real phone with keys, or a phone approved (by a phone or a
  linked browser) for its current identity key. It reports what the server stores; computers still
  decide trust from the signatures.
- `GET /api/dashboard/pending-devices` (Dashboard session) lists the same, with `modelName` and
  `isSimulator`.
- The approver may also be a linked browser (`approval.deviceId` is then `brw_…`); see "Approving from
  a linked browser" below.

**CLI.** A pending phone becomes trusted ("auto", notice `new_phone_approved`) when its `approval`
verifies against a phone this computer trusts and covers its current identity key. No question is
sent any more. A browser approval (`brw_…` approver) counts only outside strict mode, and only while
that browser's link from a phone this computer trusts is valid (signed 14 days ago or less); the
notice then says the phone was approved from that browser.

- Notes name the waiting phone, the trusted phone(s) that can approve it and the exact command;
  `notify`, `ask` and cards name every phone they skipped and why.
- `relo keys approve <dev_…|handle>` approves a waiting phone on this computer by hand: it shows the
  name, model, when it signed in, its key id and the first group of its security code, and asks
  `[y/N]` at a terminal. Without a terminal it refuses unless `--yes` is given. The phone gets the
  trust level `approved`: sealed to like a verified phone, and strict mode still holds any later key
  change.
- `relo keys status` prints a table at a terminal (name, friendly model, plain status, last seen) with
  a short handle per phone (for example `iphone-air`); `--json` keeps `model`, `handle` and
  `lastSeenAt`.
- `relo keys remove <phone>` does not revoke (there is no CLI revoke route); it points to Dashboard →
  Account → Security → Devices → Remove.

**iPhone.** Settings → Security shows "New device wants access" with each pending device (name,
when it signed in, key id) and Approve / Decline. Approve signs as above; Decline signs the device
out. The list refreshes on foreground and when the notification is opened.

**Dashboard.** Account → Security → Devices lists every phone, computer and browser with one plain
line each: "Can read your encrypted cards", "Waiting for approval", "Not linked — can't read encrypted
content", "Simulator", "Sends encrypted cards" or "Not set up yet". `GET /api/dashboard/devices`
(Dashboard session) returns `{ devices: [{ id, kind: "phone" | "computer" | "browser", name, model,
status, addedAt, lastSeenAt, approvedBy?, linkedBy?, identityKey? }], twoFactorEnabled }`; `model` is
the friendly name ("iPhone 18 Pro Max", "Simulator") and a pending phone carries the identity key an
approval signs. Each row has Remove, with confirm copy that says it is signed out and can no longer
read anything; a pending phone has Approve and Decline instead. Remove and Decline both call
`POST /api/dashboard/devices/:id/revoke` (computers: `/api/dashboard/credentials/:id/revoke`;
browsers: `DELETE /api/dashboard/browser/:id`), and removing a phone or browser deletes what only it
could open, like signing out on the phone. The Now page notice links to Devices.

**Simulators.** A phone running in the iOS Simulator sends `isSimulator: true` on registration and in
its heartbeat (older builds omit it), and a model of `arm64`, `x86_64` or `i386` counts too
(`devices.is_simulator`, migration 0096). A simulator is shown as "Simulator", never receives an
approval notice, and never counts as the older device that makes a real phone pending: a real phone is
pending only behind an older real phone, a simulator never approves or declines a real phone, and a
browser linked from a simulator never approves one either. `GET /api/devices` adds `modelName` and
`isSimulator`; `GET /api/devices/keys` adds `simulator: boolean`. The CLI never trusts a simulator
automatically and never lets one block a real phone's automatic re-trust.

### Linked browsers (like WhatsApp Web)

The web Dashboard reads sealed content only as a *linked browser*. Signing in alone never gives a
browser keys. The accepted cost, the same as WhatsApp Web's, is that the server delivers the
Dashboard's code; pinned builds reduce it.

**Browser keys.** On first sign-in the Dashboard creates, with WebCrypto, an ECDSA P-256 identity key
and an ECDH P-256 prekey, both non-extractable, kept in IndexedDB. Key ids, prekey ids and the prekey
signature are the same as a phone's: `keyId = "k_" + b64u(SHA-256(X9.63 public key)[0..16))`,
`prekeyId = "pk_" + b64u(12 random bytes)`, and the identity signs
`prekeySigningInput(browserId, prekeyId, prekeyPublicKey, createdAt)` (raw r||s). The prekey
rotates every 10 hours; old private prekeys are kept for retention + 2 hours, then deleted.

**Registering.** The browser picks its own id, `brw_<random uuid>`, and signs its prekey for it.
`POST /api/dashboard/browser` (Dashboard session) with
`{ browserId, name, identityKey, prekey: { prekeyId, publicKey, createdAt, signature } }` returns
`{ browserId, linked }`; the same id and identity key again publishes a new prekey, and an id that
is already used answers 409 so the browser picks another. The Dashboard keeps the id in IndexedDB.

**Linking (QR).** The unlinked Dashboard shows a QR code with the text
`relo-link:1:<browserId>:<identityPublicKey b64u>`. Relo on a trusted iPhone scans it (Settings →
Security → Link a browser), and its identity key signs

```
relo.e2e.v1 link
<browserId>
<browser identity public key, b64u X9.63>
<phone deviceId>
<signedAt, ISO 8601>
```

The phone sends `POST /api/devices/self/links { browserId, identityKey, signedAt, signature }`. The
server accepts it only for a browser of the same account with that identity key and stores the
link. `GET /api/devices/self/links` lists linked browsers; `DELETE /api/devices/self/links/:id`
unlinks one (the browser is revoked).

**Sealing to browsers.** `GET /api/devices/keys` lists browsers next to phones as
`{ deviceId: "brw_…", kind: "browser", name, identityKey, prekey, link: { deviceId, signedAt,
signature } | null }`. A computer seals to a browser only when the link signature verifies against
the identity key of a phone it trusts (not pending) and covers the browser's current identity key.
Browsers get the content envelope only (no push alert).

**Reading.** The Dashboard JSON carries no envelopes, only `encrypted: true`. A linked browser asks
for them by id: `GET /api/dashboard/sealed?id=…` (notification, card and agent-session ids, at most
100) with the header `x-relo-browser: <browserId>` returns `{ envelopes: { id: envelope } }`, or 403
when that browser is not linked to the signed-in account. The Dashboard trusts the account's
computers on first use from `GET /api/dashboard/client-keys`, opens each envelope with its own
prekey, replaces the placeholder fields with the opened text, and resolves handles with the names
the envelopes carry.

### Approving from a linked browser

A linked browser can approve a pending phone, like a trusted phone, from Account → Security →
Devices. Its own non-extractable identity key signs exactly the phone's approval input with the
browser as the approver:

```
relo.e2e.v1 approve-device
<deviceId of the new phone>
<its identity public key, b64u X9.63>
<brw_… id of the approving browser>
<signedAt, ISO 8601>
```

`POST /api/dashboard/devices/:id/approve { browserId, identityKey, signedAt, signature, code? }` is
accepted only:

- from the account owner's Dashboard session, at most 10 attempts per account per 15 minutes;
- with a fresh code from the authenticator app when two-step sign-in is on;
- for a phone of the same account that is pending, whose current identity key matches;
- from a browser of the account that is linked now: a phone that is still on the account signed its
  link 14 days ago or less, and that phone is not a simulator (unless the target is one);
- when `signature` verifies against that browser's published identity key, with `signedAt` within 10
  minutes of the server's clock.

The server stores it with `approved_by_browser` (migration 0096; `approved_by_device` stays null) and
lists it like a phone's approval: `approval: { deviceId: "brw_…", signedAt, signature }`. A phone
that is not pending answers 404, one already approved 409 `already_approved`, an unlinked or expired
browser 403 `browser_not_linked`, a bad signature 400 `invalid_signature`. Decline in the Dashboard
removes the phone. An unlinked browser shows "Link this browser from your iPhone first" in place of
Approve, with the QR code below.

**The trade-off.** The server delivers the Dashboard's code (see "Linked browsers"). A malicious
server could serve code that makes a linked browser approve a phone the server added itself, which a
phone's approval cannot be tricked into. The mitigations: only a browser a trusted phone linked (in
the last 14 days) can approve; the owner's session and, with two-step sign-in, a fresh code are
needed; the CLI announces "approved from <browser>" so an unexpected approval is visible; and strict
mode (`relo keys strict on`) refuses browser approvals entirely, so a phone then needs a phone's
approval or `relo keys verify`/`approve`.

## Current state (14 October 2026)

Shipped in the current server, CLI and iOS releases unless the row says otherwise:

| Item | State |
| --- | --- |
| E0.3 Interop | Done: `packages/cli/src/e2ee.mjs` (RFC 9180 HPKE on `node:crypto`) and `ReloCore/E2EE/ReloE2EE.swift` (CryptoKit) seal and open each other's envelopes, signatures and safety numbers (`e2ee-v1.json`). |
| E0.2 iOS spike | Half done: on a Mac a Secure Enclave key opens HPKE envelopes and signs answers (`E2EEKeyRingTests`). Still to prove on a locked iPhone: extension and widget budgets. |
| E1.1 Retention | Done: `RELO_CONTENT_RETENTION_HOURS`, migration `0063`. |
| E2.1 Phone keys | Done: a Secure Enclave identity key; prekeys kept in the Keychain group shared by the app and both extensions (`AfterFirstUnlockThisDeviceOnly`), rotated every 10 h, private halves deleted after retention + 2 h, published with each heartbeat. |
| E2.2 Key directory | Done: migrations `0064`/`0065`, `PUT/GET /api/devices/…/keys`, `PUT /api/clients/self/keys`, `GET /api/clients/keys`. |
| E2.3 CLI trust | Done: trust on first use, automatically; `relo keys status` shows "security code changed" notices; `verify` (optional, a person), `strict on|off`, `forget`, `rotate`. |
| E2.4 Phone trust | Done: the phone trusts the account's computers automatically on launch and foreground; Settings → Security leads with "End-to-end encrypted with …", shows "Security code changed" lines, and keeps "Verify security code" optional. |
| E3.1–E3.2 Sealed notices | Done: `relo notify` seals for trusted phones; the server stores envelopes and placeholders only; the Notification Service Extension and the app open them. Project and topic names travel as keyed handles (E2.5). |
| E4.2 Signed answers | Done: the iPhone signs every answer when it is queued (in the app, from a notification, or from a Live Activity button); once a computer trusts a phone, `relo ask` acts on approved, yes or replied only with a valid signature from a trusted phone, and otherwise exits 8 (do not act). Negative answers need no signature. |
| E4.1 Sealed questions | Done: `relo ask` seals the question's title, prompt and detail for trusted phones on both the card path and the in-app path; the server stores the placeholder "Encrypted question" and the envelopes; the iPhone opens them in the app, the notification and the card (E5). Answer button labels stay readable. |
| E4.3 Sealed replies | Not needed for now: new questions take tappable answers only (typed replies were removed). If typed replies return, they must be sealed to a per-question key carried inside the sealed question. |
| E1.2 Card retention | Done: the retention window also deletes ended cards (title, status, steps, snapshots) once their events are gone; active cards are never touched (migration `0069`). |
| E1.3 Keyed body digest | Done: bodies are digested with a server-keyed HMAC instead of plain SHA-256, and earlier plain hashes are overwritten (migration `0068`). |
| E6.3 Replay protection | Done: the iPhone remembers which notification first carried each envelope context, in the shared Keychain, and blocks the same envelope under another notification ("A repeated encrypted message was blocked"). |
| E5 Sealed cards | Done: a work's card is sealed. `relo work` start, update, pause and finish seal the goal, status, outcome, waiting reason and step labels for trusted phones; the request carries `{sealed: true}` in place of the text and one card envelope (kind `card`: title, status and steps) that the phone's widget opens. The server stores placeholders ("Encrypted card", "Updating…") and the latest envelopes (migration `0082`), keeps plan structure (step ids, states, counts) in the clear so it can check the plan, and each phone's Live Activity push carries its own envelope. The phone opens it while decoding the card state, so the Lock Screen, Dynamic Island and Watch show the real text; words the server writes itself ("Approved", "Expired") are kept. A question folded into a card shows its real prompt the same way. The producer's own sealed copy: because the server cannot read a work's text, the CLI also uploads the goal, status, waiting reason and step labels sealed under a key derived from this computer's identity key (AES-256-GCM, `relo.work-self.v1`). Only that computer can open it; the server returns it only to the same session, and the CLI rebuilds its local working copy from it when the state file is lost. Scripts and services cannot seal, so their work is readable text and is labelled as such. |
| E6.1 Enforcement | Done: `relo keys require on` (a person at a terminal) makes the account refuse readable notices, questions and card text from CLI keys with `end_to_end_required` (migration `0083`); webhooks and server-made messages are unaffected and labelled. The card `relo ask` starts is sealed too. |
| E6.4 Proof | Done: `apps/server/src/compromised-server.test.ts` runs the real `relo` CLI against a real server for a verified phone (notice, card with steps, an update, a question), then searches every row of every table for the agent's words, project and computer names and finds none; a control run with the policy off proves the search finds readable text. An internal adversarial review (13 October 2026) found and fixed: approvals replayable across questions and re-targetable to another question (now bound to the interaction, the question's context and the time asked); server-added phones trusted silently (now *pending*); readable fallback after a key problem (now fails closed); a card key that leaked the project name (now keyed); a new computer added without notice on the phone (now "Added …" on Settings → Security, which also lists computers the server stopped listing); one computer able to rename another's projects (names are kept per sender); server text shown on unopened sealed rows (now placeholders); encryption state kept across sign-out (now deleted). `packages/cli/test/e2ee-review.test.mjs` and the iOS `E2EE*Tests` cover them. The key, client-key and policy routes need no extra scope: they return public keys and a flag only. Still open: an external review of the protocol and code. |
| E2.5 Opaque names | Done: the CLI sends keyed handles (`p-…`, `t-…`, `w-…`, `c-…`, `a-…`) for project, topic, task, computer and account, keyed per computer, and seals the names (session names too, see below); the iPhone remembers handle → name and shows the names everywhere (inbox, history, Now, cards). The same project used from two computers has two handles but one name on the phone. |
| Default policy | Encryption is required automatically once a phone of the account has keys (migration `0084`): CLI keys then must seal. `relo keys require off` (a person) turns it off; `on` and `auto` need nobody. |
| Phone surfaces | Every feed the iPhone reads carries that phone's envelopes next to the placeholders: inbox detail and history, the snapshot, current state (Now → Live now), `GET /api/now` (each item's `sealed.card` and `sealed.question` content envelopes, phones only) and pending decisions, plus Live Activity pushes. The app opens them on arrival, so no screen shows "Encrypted card" or a handle when the phone holds the key. The web Dashboard has no key by design: its JSON carries only an `encrypted` flag (never the envelopes), and it shows a lock with "End-to-end encrypted · open on iPhone to read" in place of a sealed title, body, status or prompt (time, state, source and step counts stay), and names handles "Encrypted project", "Encrypted topic", "Encrypted task", "Encrypted computer" or "Encrypted account". The Live Activity widget process has no Keychain at all, so the app and the Notification Service Extension also write a widget key mirror into the App Group container whenever they save: the software prekeys' private halves, the trusted computers and the project names, never the identity key, which stays in the Secure Enclave. The mirror is readable only after the first unlock since boot, only by Relo and its extensions, is excluded from backups, and never leaves the iPhone; retired prekeys leave it with the key ring. |
| Locked phone | Fixed (P0): a CryptoKit Secure Enclave key works only in the process that created it (the app), so the Lock Screen widget and the Notification Service Extension stayed on placeholders. Prekeys are now software keys in the shared Keychain item, usable after the first unlock since boot and never leaving the phone (like WhatsApp's and Signal's message keys); an older Secure Enclave prekey is replaced on the app's next run. The identity key stays in the Secure Enclave, so approving still needs an unlocked phone. |
| Names on stored rows | Fixed (P0): rows the app stored before a name arrived kept showing handles; handles are now swapped for names when a row is shown, and only the handle is stored. |
| Session names and handles | A session's project, computer and account travel as keyed handles, and the session's name is read from Claude Code's own files on the computer (the title the owner or Claude gave the conversation). The outbox flusher seals the names and the title for the phones (envelope kind `names`, migration `0085`) when it sends the session's next observed phase snapshot, once per session and again only when they change; the server stores the envelope as is and returns it only to phones (`GET /api/now`, the Sessions rows) and to linked browsers through `GET /api/dashboard/sealed`, never in the Dashboard JSON or the CLI's `relo sessions` list. A prompt, tool name or transcript never leaves the computer ([HOOKS-AND-HARNESSES.md](HOOKS-AND-HARNESSES.md)). |
| Linked browsers | Done (13 October 2026), verified end to end against a local server: the Dashboard made its own WebCrypto keys, a phone with real keys signed its QR link, a fresh `relo` trusted the browser only through that signature, and the Dashboard opened the sealed notice, card and agent-session names itself. Items sealed before linking stay locked. Signing out deletes the browser's keys. |
| Device trust in the Dashboard | Done (14 October 2026): Account → Security → Devices lists phones, computers and browsers with a plain encryption status, friendly model names and Remove (which deletes what only that device could open); a linked browser approves a pending phone (with a two-step code when it is on); simulators are labelled and never vouch for a real phone. Server tests: `web/dashboard-devices.test.ts`, `device-approvals.test.ts`, `device-models.test.ts`. |
| Everything else | Open, in the order below. |

## Delivery plan

Each item is merged on `main`, its local gates pass, and any server change is deployed and checked
live. Work happens in this order.

### Phase E0 — Decide and prove

- **E0.1 — ADR 0005 accepted.** Covers the threat model, the metadata the server keeps, and the
  content classes that stay server-sealed.
- **E0.2 — iOS spike.** The spike must prove all three:
  - A Secure Enclave P-256 key, stored in a Keychain access group, can open an HPKE envelope:
    - in the app;
    - in the Notification Service Extension within its budget (today 150 ms total, and decryption
      runs before enrichment);
    - in the widget while it renders a Live Activity on a locked device after first unlock.
  - The widget can sign an answer.
  - Outcome: the Live Activity route is chosen.
- **E0.3 — Interop test vectors.** CryptoKit and the CLI's `node:crypto` HPKE each open the other's envelopes;
  vectors are committed under `packages/contracts/fixtures/e2ee-v1/`.

### Phase E1 — Reduce what the server keeps (needs no keys)

- **E1.1 — Automatic content retention.** The worker runs bounded retention every few minutes when
  `RELO_CONTENT_RETENTION_HOURS` is set, through a runtime-callable function with fixed safe
  parameters. See [Self-hosting](SELF-HOSTING.md#content-retention).
- **E1.2 — Expire ended cards and their snapshots.** Ended `live_activities` rows, operations and
  presentation snapshots older than the window are purged. Project, conversation and work-item
  names with no live references are garbage-collected.
- **E1.3 — Stop storing a plaintext body hash.** `notification_contents.content_sha256` is
  replaced with an HMAC. Someone with the database can currently test guesses against it.
- **E1.4 — Phone-side history.** The app keeps its own history, so a short server window loses
  nothing the owner can see.

### Phase E2 — Keys and verification

- **E2.1 — Device keys.** The identity key and rotating prekeys live in the Secure Enclave, in a
  shared Keychain access group, on the app and both extensions. They are registered with
  `POST /api/devices/self/keys` and rotated on foreground, on heartbeat and in background refresh.
  Old private prekeys are deleted on schedule.
- **E2.2 — Server key directory.** A `device_keys` table holds public halves only, plus their
  signatures. It is exposed through `GET /api/devices` to `devices:read` CLI keys. Revoked devices
  disappear from it immediately.
- **E2.3 — CLI identity and trust store.** `relo keys status|verify|rotate|forget`, the safety
  number, `trust.json`, and `relo doctor` checks.
- **E2.4 — Phone security screen.** Shows the safety number, the trusted CLIs, cross-signing of new
  devices, and warnings when a key changes.
- **E2.5 — Account grouping key.** Created on the phone and sealed to each verified CLI.

### Phase E3 — Sealed notices

- **E3.1 — CLI seals `relo notify`.** The CLI sends metadata (refs, tone, state, digest) plus the
  envelope. The server stores the envelope as opaque data and never decrypts it.
- **E3.2 — Notification Service Extension decrypts.** It replaces the placeholder alert text
  before display. The app decrypts on sync and in detail views.
- **E3.3 — Server code paths metadata-only.** Previews, presentation policy, project grouping,
  idempotency and APNs budgets work from metadata for sealed items. A test proves that a database
  dump plus the server secret cannot recover sealed text.

### Phase E4 — Sealed questions and signed answers

- **E4.1 — Sealed questions.** The prompt and labels for `relo ask` and the questions folded into
  cards are sealed.
- **E4.2 — Signed answers.** Signatures come from the app, the notification actions and the Live
  Activity buttons. The CLI verifies them before it reports `approved`. The signed value is the
  action (`approve`, `yes`), `choose:<optionId>` for a picked option, or `answer:<sha256>` for a reply.
- **E4.3 — Sealed replies.** Typed replies are sealed to the per-question key, and callbacks carry
  the sealed reply.

### Phase E5 — Sealed Live Activities

- **E5.1 — Sealed cards.** Card start, update and end are sealed, along with their steps, using
  the route E0.2 chose.

### Phase E6 — Enforce and finish

- **E6.1 — Account setting "Require end-to-end encryption"** (on by default for new accounts once
  E5 ships). The server refuses unsealed content from CLI keys on that account. Webhooks still
  work and are labelled.
- **E6.2 — Dashboard shows metadata only for sealed items.** The phone shows the protection level
  on every item.
- **E6.3 — Replay protection.** A server can re-deliver an old sealed notice; its signature
  is still valid. The phone remembers the `context` of every envelope it opened and shows
  `sentAt`, and it rejects a repeat outside an exact retry.
- **E6.4 — Size padding,** the threat-model test suite, an external review of the protocol and
  code, and documentation (README, SECURITY.md, self-hosting).

## Testing

- **Contract vectors:** run in both the Swift and the Node suites.
- **"Compromised server" suite:** given a database dump, the server secret and the APNs payloads,
  no sealed field can be recovered.
- **Forgery tests:** the server swaps a key and gets refused; the server forges an answer and the
  CLI rejects it; the server replays an envelope to another account and AAD verification fails.
- **Rotation tests:** after a prekey is deleted, earlier envelopes fail to open.
- **Retention tests:** expired content is gone, and pending and active items survive.
