# Relo encryption protocol

The exact keys, message formats and signing inputs behind Relo's end-to-end encryption, for people who
build or review Relo: the CLI (`packages/cli/src/crypto`), the server (`apps/server/src`), the iPhone
app (`apps/ios/Sources/ReloCore/E2EE`) and the Dashboard (`apps/dashboard/src/lib/e2ee`). What the
protection means for you, and how to use it, is in [Encryption](site/concepts/encryption.md) (served at
`/docs/concepts/encryption`). The decision is [ADR 0005](adr/0005-end-to-end-encrypted-content.md).

## Cryptography

These are standard primitives only, with no Relo-specific crypto:

- **HPKE (RFC 9180)**, using DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM.
  - P-256 is the curve the iPhone's Secure Enclave supports.
  - CryptoKit provides HPKE on iOS 17 and later. Relo's minimum is iOS 17.2.
  - The CLI implements RFC 9180 base mode on `node:crypto` primitives (`packages/cli/src/crypto/e2ee.mjs`),
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

## Keys

| Key | Where it lives | Lifetime | Purpose |
| --- | --- | --- | --- |
| Device identity key (ECDSA P-256) | iPhone Secure Enclave, in a Keychain access group shared by the app and both extensions | The life of the install | Signs prekeys and answers. Approves new devices. |
| Device prekey (P-256 key agreement) | A software key in the Keychain item shared by the app and its extensions, readable after the first unlock and never leaving the device (`AfterFirstUnlockThisDeviceOnly`). A CryptoKit Secure Enclave key works only in the process that created it, so the extensions could not open content with one. The Live Activity widget has no Keychain at all: it reads the App Group mirror below. | Replaced every `rotation` (10 h by default). The private half is deleted after `retention + grace` | Receives sealed content |
| CLI identity key (ECDSA P-256) | CLI config directory, file mode 0600. The macOS Keychain later. | The life of the login. `relo keys rotate` replaces it. | Signs every envelope the CLI sends |
| Per-question reply key (P-256 key agreement) | CLI state directory, deleted when the question resolves | One question | A sealed typed reply, if typed replies return, so each reply has its own forward secrecy |
| Account grouping key (256-bit) | Created by the first paired iPhone and sealed to each CLI when it is verified | Long-lived; rotating it regroups projects | Turns project and topic names into opaque handles the server can group by |

The phone publishes `{prekeyId, publicKey, createdAt, signature-by-identity}`. The server stores
public halves only.

### App Group key mirror

The Live Activity widget process has no Keychain. The app and the Notification Service Extension
therefore also write a mirror into the App Group container whenever they save: the software prekeys'
private halves, the trusted computers and the project names, never the identity key, which stays in
the Secure Enclave. The mirror is readable only after the first unlock since boot, only by Relo and its
extensions, is excluded from backups and never leaves the iPhone. Retired prekeys leave it with the key
ring. Because the identity key stays in the Secure Enclave, approving and signing need an unlocked phone.

## Envelope

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
## What the server still needs, sent as metadata

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
## Answers that the server cannot forge

- An approval, denial, yes or no is signed by the device identity key over `{interactionId,
  notificationId, deviceId, value, respondedAt}`. For a sealed question the phone also signs the
  same fields plus the `context` of the envelope it opened (`relo.e2e.v1 answer-to`), and only when it
  actually opened that question. The CLI requires this second signature for a question it sealed,
  checks that it names the interaction it is waiting for (or, for a phone that answered another copy
  of the same sealed question, that copy; see "Answers on another copy") and that it was made after
  the question was asked, so the server can neither replay an old approval nor show the phone a
  different question.
- The server stores the signature next to the state it already keeps, so cards and callbacks still
  work. The CLI accepts `approved` only when the signature verifies against a trusted device: a phone
  it trusts, or, outside strict mode, a browser such a phone linked in the last 14 days (see
  "Answering from a linked browser").
  `relo ask --approval` keeps its contract: exit 0 with state `approved`, now with a verified
  signature behind it.
- A typed reply is sealed to the question's one-time reply key. Callbacks receive the sealed reply.
- Live Activity buttons sign from the widget extension with the same identity key, through the
  shared access group.
## Live Activities

Live Activity content state is delivered by ActivityKit straight to the widget, with no extension
hook to decrypt it first. Relo takes the first of two routes: the widget's SwiftUI view opens the
sealed `presentation` field with a prekey from the App Group mirror above, while rendering. (The
alternative, pushing neutral state and re-applying sealed text from the app with `Activity.update`,
would leave a cold Lock Screen on generic labels until the app runs.) Each phone's Live Activity push
carries only its own envelope.

The interaction `credential` in content state is a server capability, not content, and stays as it
is.

## Prekey lifetime

The phone deletes a private prekey once `retention + 2 h` has passed since a newer prekey replaced it,
when the app or an extension next runs (iOS does not guarantee when). From then on every envelope
sealed to that prekey is unreadable, including any copy taken before the purge. If the phone has not
run for a long time the CLI keeps using the newest signed prekey; the server marks a prekey older than
7 days as stale and `relo keys status` shows `stale`.

## New devices are approved on a trusted phone

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

**iPhone.** Settings → Devices shows "New device wants access" with each pending device (name,
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

## Computers are approved once, on any trusted device

A computer that signs in after a device's first contact is *pending* on that device: its cards, names
and notifications do not open there. Before, each device decided alone (a phone's Approve stayed on
that phone), so a computer approved on the iPhone stayed pending on the Mac app and on other phones.
Now any trusted device approves it once, and every other device follows by checking the signature,
never the server's word.

**Approvers.** A phone, the Mac app (an owner overview device) or a linked browser of the account.
Each signs with its own identity key

```
relo.e2e.v1 approve-computer
<key_… clientId of the computer's login>
<the computer's identity public key, b64u X9.63>
<approver id: dev_… or brw_…>
<signedAt, ISO 8601>
```

**Server.**
- `POST /api/devices/self/computer-approvals { clientId, identityKey, signedAt, signature }` (device
  credential) stores the approval when the computer belongs to the account, `identityKey` is its
  current key and the signature verifies against the caller's published identity key. A simulator
  never approves a computer.
- `POST /api/dashboard/computers/:clientId/approve { browserId, identityKey, signedAt, signature }`
  (Dashboard session) does the same for a linked browser, under the rules of "Approving from a linked
  browser".
- `POST /api/devices/self/computers/:clientId/revoke` (device credential) signs a computer out like the
  Dashboard's revoke: its login stops working (204; `404 computer_not_found` for an unknown, other-account
  or already signed-out computer; `403 device_pending` from a phone still waiting for approval).
- One approval per computer key and approver (migration 0119, `computer_approvals`). A changed key
  needs a new approval; the old ones stop being listed.
- `GET /api/clients/keys` and `GET /api/dashboard/client-keys` add `approvals: [{ approverId, signedAt,
  signature }]` for each computer's current key.
- `GET /api/devices/self/approvers` (device credential) and `GET /api/dashboard/approvers` (session)
  list who can approve: `{ approvers: [{ id, kind: "phone" | "mac" | "browser", name, identityKey,
  vouchedBy: { approverId, signedAt, signature, statement: "approve-device" | "link" } | null }] }`.
  `vouchedBy` is the device approval (or, for a browser, the link) that covers its current key.

**Every device decides.**
- It pins approvers like computers: at its first contact, itself and the approvers then listed; after
  that, a new approver (or a new key) only when its `vouchedBy` signature verifies against an approver
  already pinned, over its current key.
- A pending or new computer becomes trusted ("auto", notice `approved_elsewhere` naming the approver)
  when one of its `approvals` verifies against a pinned approver and covers its current key. The
  computers present at a device's first contact are still trusted on first use.
- Every approver signs an approval for each computer it trusts whose current key it has not approved
  yet, so the computers it trusted on first use, and the ones the owner approved on it, count on
  every other device too.
- A computer declined on a device stays declined there. A decline does not travel.

Computers (the CLI) do not verify computer approvals: they seal to phones and browsers, never to each
other.

### Key binding

A join code vouches for the key that redeems it, so the issuing device can approve the computer without trusting
the server's word about which key that was. The code is `rci_<redeem 32 chars>.<bind>`; `<bind>` is 16 random
bytes (b64url, 22 characters) made by the issuing device (the Dashboard tab or the iPhone), never by the server,
and kept only for the code's 30 minutes. The server sees and hashes the `rci_` half alone; `relo auth join` splits
the code on the first `.`, redeems the first half and publishes the identity key with

```
binding = b64url( HMAC-SHA256( key = b64url-decode(<bind>),
                                message = "relo.e2e.v1 computer-binding\n" + <key_… clientId of the login> + "\n"
                                          + <identity public key, b64u X9.63, as published> ) )   // 43 characters
```

computed in `packages/cli/src/crypto/trust.mjs` (`computerBinding`, called by `publishJoinKey`). The bind half is
never written to disk or logs. `PUT /api/clients/self/keys` takes the optional `binding`, stores it when the key is
created or changes (a re-publish of the same key keeps the stored one) and never verifies it. It is listed as
`binding` beside the key in `GET /api/clients/keys`, `GET /api/dashboard/client-keys` and the invite status
(`computer.identityKey`, `computer.binding`). The issuing device recomputes the HMAC and signs `approve-computer`
only when it matches. A code without a bind half (from `relo auth invite`), or a device that no longer holds the
bind half, leaves the computer to be approved the ordinary way.

### Sign-in number

A computer without a code (`relo auth login`) makes its identity key before it starts the sign-in and sends it as
`identityKey` (b64u, 65 bytes) to `POST /api/device-authorizations/start`. The server stores and relays it; it never
judges it. The CLI prints a two-digit number, and the approving device computes the same one from the key the server
relays and shows it among two random decoys; the owner picks the printed number:

```
number = ( first two bytes of SHA-256( "relo.e2e.v1 signin-number\n" + userCode + "\n" + identityKey ), big-endian uint16 ) mod 100
```

`userCode` is as printed (`ABCD-EFGH`), `identityKey` the b64u text as sent; two digits, zero-padded. A key the
server swapped in gives another number. The code is `signinNumber` in `packages/cli/src/crypto/signin-number.mjs`;
`packages/contracts/fixtures/signin-number-v1.json` holds vectors for every implementation. The request reads
(`GET /api/devices/self/sign-ins/:userCode`, `GET /api/device-authorizations/requests/:userCode`) return
`identityKey`, and once the token was issued `clientId` (`key_…`) and `keyPublished` (that login's published key equals
the key the sign-in started with). The device signs `approve-computer` for that key only when the number was picked
and `keyPublished` is true.

## Linked browsers (like WhatsApp Web)

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
Devices → Link a browser), and its identity key signs

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

**Linking (approval on the iPhone).** Instead of scanning, the owner can ask from the browser: the
phone then signs exactly the same link statement, over the identity key the server listed. The QR
code carries the key out of band; this path carries it through the server, so both screens show the
browser's **link code** and the owner approves only when they match. The link code is the first
three groups of the browser identity key's fingerprint (the Signal-style chunks behind the safety
number: 5200 rounds of SHA-512 over `0x00 0x00 || key`, each round hashing the previous output then
the key; 5-digit groups from 5-byte big-endian slices mod 100000), for example `04817 55932 20368`.
A server that swapped the key would have to find a key whose 15-digit code matches, at 5200 hashes
per try.

- `POST /api/dashboard/browser/:browserId/link-request` (Dashboard session, a not yet linked browser
  of the account) records the request and sends the account's trusted phones (real, notifications
  allowed, keys published, not themselves waiting for approval) a plain notification "<browser
  name> wants to read your Relo cards" ("Approve it in Devices if the code matches the one in your
  browser"), deep-linking to `relo://security/request/<brw_…>` with the APNs category
  `RELO_BROWSER_LINK` and the payload `{ browserLink: { browserId } }`. That category has one
  action, Review, which opens the request: a browser is never approved from the notification,
  since the owner must compare the code first. It answers
  `{ requested: true, phones }`; `409 no_phone` when no phone can show it, `409 already_linked`,
  `404 browser_not_found`, and `429 too_soon` within 30 seconds of the last request.
- `GET /api/devices/self/link-requests` (phone credential) → `{ browsers: [{ browserId, name, keyId,
  identityKey, requestedAt }] }`: browsers that asked in the last 15 minutes and are not linked.
- Approving is `POST /api/devices/self/links` as above, which also clears the request.
- `POST /api/devices/self/link-requests/:browserId/decline` clears the request (204, or 404). It
  does not sign the browser out; the owner removes a browser they do not know in Devices.
- The iPhone lists a waiting browser with the phones and computers under "New device wants access",
  showing its name, when it asked and its link code, with Approve and Decline. The browser shows the
  same code while it waits and learns it was linked as it does after a scan.

**Sealing to browsers.** `GET /api/devices/keys` lists browsers next to phones as
`{ deviceId: "brw_…", kind: "browser", name, identityKey, prekey, link: { deviceId, signedAt,
signature } | null }`. A computer seals to a browser only when the link signature verifies against
the identity key of a phone it trusts (not pending) and covers the browser's current identity key.
Browsers get the content envelope only (no push alert).
An envelope is sealed to the devices linked when it is written, and nothing seals it again: what was
sent before a browser was linked stays readable only on the phones. The one exception is a session's
`names` envelope, which a computer seals again (at most every 10 minutes) when the set of recipients
changed, so a browser linked mid-session can name that session's projects. A linked browser whose page
still holds sealed items tries to open them again a few times, since computers learn of the new
browser at their next command.

**Reading.** The Dashboard JSON carries no envelopes, only `encrypted: true`. A linked browser asks
for them by id: `GET /api/dashboard/sealed?id=…` (notification, card and agent-session ids, at most
100) with the header `x-relo-browser: <browserId>` returns `{ envelopes: { id: envelope } }`, or 403
when that browser is not linked to the signed-in account. The Dashboard trusts the account's
computers on first use from `GET /api/dashboard/client-keys`, opens each envelope with its own
prekey, replaces the placeholder fields with the opened text, and resolves handles with the names
the envelopes carry.

## Approving from a linked browser

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

## Answering from a linked browser

A linked browser answers questions and approvals from the Dashboard, like the iPhone: the same
buttons with the sender's own labels, the time left, one answer per question. Its own non-extractable
identity key (`apps/dashboard/src/lib/e2ee/answer.ts`) signs exactly what the phone signs, with the
browser's `brw_…` id as the answering device:

```
relo.e2e.v1 answer
<interactionId, int_…>
<notificationId, ntf_…>
<brw_… id of the answering browser>
<value: approve | deny | yes | no | choose:<optionId>>
<respondedAt = e2eeSignedAt, ISO 8601>
```

For a sealed question the browser first opens the question's envelope (it must be a recipient: the
computer sealed the question to it because a trusted phone linked it), shows the opened prompt, and
also signs the `answer-to` input with the envelope's `context` appended, exactly as the phone does. A
sealed question this browser cannot open cannot be answered from it.

**Which copy the browser answers.** A question folded onto a card has one copy per phone (each its
own interaction and notification, each phone answering its own), and one that outlives its card
continues as a notification of the same decision. The asking computer follows exactly one copy, the
one the server returned when it asked (recorded as the card wait's `interaction_request_id`; without
one, the card update's first copy), and verifies an answer's signature over that copy's ids. A
browser has no copy of its own, so the server makes it answer that one: `GET
/api/dashboard/questions/:int_id` takes any copy's id (a Now item names the newest copy) and returns
the waited copy's `id` and `notificationId`, which the browser signs; the answer route refuses an
answer to any other copy (409 `not_asked_copy`) before it decides anything. This changes nothing the
computer accepts: the signature still names the exact interaction and notification it waits on and,
for a sealed question, the context it sealed. All copies of a sealed question carry the same
envelopes (one `context`), including the notification a long question continues as, so a sealed
long question stays sealed and answerable with the context bound. An expired copy resolves to the
waited copy's own state. The design choice: resolving on the server keeps the computer's rule ("the
answer names the question I asked") exact; accepting any sibling copy in the CLI would need the
computer to trust a server-supplied list of copies. A phone is different: it can only sign its own
copy, so its answer on another copy follows "Answers on another copy" below.

## Answers on another copy

A phone answers its own copy of a question: a second iPhone taps its own card's buttons, and the Lock
Screen buttons of a long question answer the card's copy while the computer waits on the notification
the question continues as. Every copy takes the decision (the same state and the same signed response),
and each copy the decision reaches from elsewhere records the copy that was actually answered
(`interaction_requests.answered_on_request_id`, migration 0107; a copy settled from a copy that was
itself settled from elsewhere passes on the original). The answering phone is read from that copy's
evidence row, and `GET /api/interactions/:id`, `/wait`, the answers stream and callbacks add
`answeredCopy: { id: "int_…", eventId: "ntf_…" }` when it is not the copy itself.

The computer (`packages/cli/src/crypto/answer-verify.mjs`) then verifies the phone's signatures over
`answeredCopy`'s ids instead of the waited copy's, and only when all of these hold:

- the question is one this computer sealed and remembers, so it holds the envelope `context` it chose
  (`ntf:` + SHA-256 of its idempotency key, a random value per question unless the caller fixes one);
- the phone's `answer-to` signature binds the answer to exactly that context, and its plain answer
  signature verifies too;
- the answerer is a phone this computer trusts (not pending), with its pinned key, signed after the
  question was asked, over the value the state says.

A linked browser never needs this (it always answers the waited copy), so a browser's answer on
another copy is refused, and strict mode is unchanged. An unsealed question, or one asked on another
computer (`relo interaction wait` without the remembered context), accepts only the exact copy.

Why this is safe although the server names the copy: the copy ids carry no trust of their own here.
What binds the answer to the question is the context, a value only this computer chose, carried in
envelopes only it signed; a phone signs `answer-to` with a context only after opening such an envelope.
A server that names a copy of a different question (or relabels any copy) presents a signature bound
to another context, or over ids it did not sign, and the computer refuses it (exit 8). It needs no
iOS change: phones keep signing their own copy's ids and the context, as they always have. The
alternatives were weaker or larger: trusting a list of copies the server returns at ask time is still
the server's word, and adding an ask id to what phones sign changes every phone and the signing input,
for what the sealed context already gives.

**Sealed only to phones.** With the header `x-relo-browser: brw_…`, the question of a sealed question
carries `readableHere`: false when the computer did not seal it to this browser (sealed before the
browser was linked, or by a computer that does not trust its link). The Dashboard then says "This
question was sealed to your iPhone only. Answer it on your iPhone." and shows no buttons; the answer
route would refuse it anyway (403 `question_unreadable`).

**Server.** `GET /api/dashboard/questions/:int_id` (Dashboard session; any copy's id) returns `{ question: { id,
notificationId, kind, prompt, encrypted, readableHere?, state, expiresAt, source, actions: [{ action,
label, optionId? }] } }`, the waited copy's ids the browser signs and the sender's labels. `POST
/api/dashboard/questions/:int_id/answer` with the header `x-relo-browser: brw_…` and `{ notificationId,
action, optionId?, idempotencyKey, signature: { e2eeKeyId, e2eeSignedAt, e2eeSignature, e2eeQuestion?,
e2eeQuestionSignature? } }` is admitted only:

- from the account owner's Dashboard session, same origin, within the account's answer rate limit;
- from a browser of the account that is linked now: a phone still on the account signed its link 14
  days ago or less (403 `browser_not_linked` otherwise, also for another account's browser);
- for a question of the same account (404 otherwise), on the copy its asker waits on (409
  `not_asked_copy` otherwise);
- when `e2eeKeyId` is the browser's key, `e2eeSignedAt` is within 10 minutes of the server's clock and
  both signatures verify against its published identity key (400 `invalid_signature`);
- for a sealed question, only from a browser the question was sealed to (403 `question_unreadable`),
  bound to that envelope's `context`.

It is then recorded exactly like a phone's answer (`interactions.browser_id`, migration `0105`;
`device_id` stays null): first valid answer wins, a retry with the same `idempotencyKey` is the same
answer (`replayed: true`), a second answer finds the question decided (409 `interaction_not_pending`),
and an answer after expiry is stored as a late answer, a fact for the producer and never permission.
Every read that names who answered (`respondingDevice`, callbacks' `device`, `relo listen`) names the
browser as `{ id: "brw_…", name: "Chrome on macOS" }`. The server admits; it never decides trust.

**CLI.** `relo ask`, `relo interaction wait` and `relo listen` accept a positive answer from `brw_…`
only when all of these hold, checked when the answer arrives:

- strict mode is off (`relo keys strict on` refuses every browser answer, approvals and plain
  questions alike, without asking the server);
- the current key listing (`GET /api/devices/keys`) still lists the browser with a link signed by a
  phone this computer trusts (not pending), over the browser's current identity key, 14 days ago or
  less;
- the answer's signature verifies against that key, names the interaction this CLI waits for, was made
  after the question was asked, and for a question this CLI sealed, is bound to the context it sealed.

Anything else is treated as no answer: exit 8, state `unverified`, with the reason ("answered in a
linked browser, which strict mode does not accept", "answered in a browser that is no longer linked",
"answered in a browser without a current link from a phone this computer trusts (links last 14 days)",
"the browser answered a different question", "the signature does not match"). Negative answers need no
signature, as from a phone. An accepted browser answer carries `answeredIn: { browser, name }` so an
answer the owner did not give is visible.

**The trade-off** is the one in "Approving from a linked browser": the server delivers the
Dashboard's code, so a malicious server could serve code that makes a linked browser sign a yes. The
mitigations: only a browser a trusted phone linked in the last 14 days, signed in as the owner, can
answer; every answer names the browser; and strict mode turns browser answers off entirely, so only a
phone's signature counts. Two-step sign-in is not asked for each answer (the phone does not ask
either); it protects the sign-in and linking.
