# End-to-end encrypted content

Status: **in progress.** [ADR 0005](adr/0005-end-to-end-encrypted-content.md) records the decision.
The table under [Delivery plan](#delivery-plan) is the current truth for what ships.

## Goal

What an agent tells you through Relo is readable only on the computers and iPhones you paired. The
Relo server, its database, its backups, the person who runs it, and Apple's push service carry
that content without being able to read it. They also cannot forge it, and cannot forge your
answer to a question. Content on the server expires after a short window (10 hours by default).
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
| The server operator or admin, including a malicious one with full control of the code it runs | Cannot read content and cannot forge content or answers. Can still see metadata, delay or drop messages, and deny service. Cannot add a device the CLI will encrypt to without that device being verified. |
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
  - The CLI uses `@hpke/core` on Node's WebCrypto.
- **ECDSA P-256 (SHA-256)** for signatures.
- Content is encrypted once with a random 256-bit key using AES-256-GCM. That key is then wrapped
  with HPKE separately for each recipient device. Associated data (AAD) binds the envelope to its
  kind, account, sender key, idempotency key and recipient.
- Cross-implementation test vectors live in `packages/contracts/fixtures/e2ee-v1/`. CryptoKit and
  Node each seal and open the other's vectors.

### Keys

| Key | Where it lives | Lifetime | Purpose |
| --- | --- | --- | --- |
| Device identity key (ECDSA P-256) | iPhone Secure Enclave, in a Keychain access group shared by the app and both extensions | The life of the install | Signs prekeys and answers. Cross-signs new devices. |
| Device prekey (P-256 key agreement) | Secure Enclave, same access group | Replaced every `rotation` (10 h by default). The private half is deleted after `retention + grace` | Receives sealed content |
| CLI identity key (ECDSA P-256) | CLI config directory, file mode 0600. The macOS Keychain later. | The life of the login. `relo keys rotate` replaces it. | Signs every envelope the CLI sends |
| Per-question reply key (P-256 key agreement) | CLI state directory, deleted when the question resolves | One question | The phone seals a typed reply to it, so each reply has its own forward secrecy |
| Account grouping key (256-bit) | Created by the first paired iPhone and sealed to each CLI when it is verified | Long-lived; rotating it regroups projects | Turns project and topic names into opaque handles the server can group by |

The phone publishes `{prekeyId, publicKey, createdAt, signature-by-identity}`. The server stores
public halves only.

### Trust: why the server cannot slip in its own key

The server hands out public keys, so it could hand out the wrong one. The CLI keeps its own trust
store, `trust.json` next to `config.json`, and encrypts only to device identity keys in that store.
A key gets into the store in one of two ways:

1. **Safety-number verification.** `relo keys verify` and the iPhone's Settings → Security screen
   both show the same 60-digit number, derived from the two identity keys as Signal's safety
   numbers are. The owner compares them and confirms on both sides.
2. **Cross-signing.** A new iPhone or iPad is trusted when a device that is already verified signs
   its identity key, after the owner approves the request on that device.

The phone also keeps a list of trusted CLI identity keys and shows any envelope from an unknown
key as unverified. When a verified key changes, both sides warn and stop until the owner verifies
again. A first-use (trust on first use) shortcut exists only in `relo setup` on a fresh account,
and the owner is still shown the safety number.

### Envelope

```json
{
  "v": "relo.e2e.v1",
  "suite": "p256-sha256-aes256gcm",
  "kind": "notice | question | card | card-update | reply",
  "sender": { "keyId": "cli_…", "sig": "base64url" },
  "aad": { "account": "…", "idempotencyKey": "…" },
  "body": { "nonce": "…", "ct": "…" },
  "recipients": [ { "deviceId": "…", "prekeyId": "…", "enc": "…", "wrappedKey": "…" } ],
  "pad": 512
}
```

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
  notificationId, deviceId, value, respondedAt}`.
- The server stores the signature next to the state it already keeps, so cards and callbacks still
  work. The CLI accepts `approved` only when the signature verifies against a trusted device.
  `relo ask --approval` keeps its contract: exit 0 with state `approved`, now with a verified
  signature behind it.
- A typed reply is sealed to the question's one-time reply key. Callbacks receive the sealed reply.
- Live Activity buttons sign from the widget extension with the same identity key, through the
  shared access group.

### Live Activities

Live Activity content state is delivered by ActivityKit straight to the widget, with no extension
hook to decrypt it first. The plan has two routes; a spike (item E2 below) picks one:

1. **Decrypt while rendering.** The widget's SwiftUI view opens the sealed `presentation` field
   using the shared Secure Enclave key. This needs the decryption to fit the widget's memory and
   time budget on a locked device.
2. **Neutral content state.** Pushed content state carries only state, progress, tone and times.
   Text arrives sealed in a silent push or a sync, and the app re-applies it locally with
   `Activity.update`. On a cold Lock Screen the card shows generic labels until the app runs.

The interaction `credential` in content state is a server capability, not content, and stays as it
is.

### Retention and forward secrecy

- **Server.** Notification history, questions, replies and sealed bodies are deleted after
  `RELO_CONTENT_RETENTION_HOURS` (the recommended value is 10), with the same safeguards as the
  manual tool: pending questions, active cards and current relevance heads are never pruned.
  Ended Live Activity rows, operation snapshots and unused project handles follow later in the
  plan.
- **Phone.** History lives on the phone, in file-protected caches, under the phone's own retention
  setting. Server history returns metadata, and the app fills in text from its cache. Text that
  has expired on both sides shows as *Expired*.
- **Prekeys.** The phone deletes a private prekey once `retention + 2 h` has passed since a newer
  prekey replaced it. This happens when the app or an extension next runs, and iOS does not
  guarantee when that is.
  - From that moment, every envelope sealed to that prekey is unreadable, including any copy
    taken before the purge.
  - If the phone has not run for a long time, the CLI keeps using the newest signed prekey. The
    server refuses to give out a prekey older than 7 days and tells the CLI the phone needs to be
    opened.

### Losing a phone

A new phone starts with empty history. That is intended: content was disposable and has expired.
The new phone is trusted through cross-signing from another verified device or through
safety-number verification on each CLI. Revoking the old device removes it from every recipient
list immediately.

## Current state (13 October 2026)

Built and tested in source, **not yet in a release**:

| Item | State |
| --- | --- |
| E0.3 Interop | Done: `packages/cli/src/e2ee.mjs` (RFC 9180 HPKE on `node:crypto`) and `ReloCore/E2EE/ReloE2EE.swift` (CryptoKit) seal and open each other's envelopes, signatures and safety numbers (`e2ee-v1.json`). |
| E0.2 iOS spike | Half done: on a Mac a Secure Enclave key opens HPKE envelopes and signs answers (`E2EEKeyRingTests`). Still to prove on a locked iPhone: extension and widget budgets. |
| E1.1 Retention | Done in source: `RELO_CONTENT_RETENTION_HOURS`, migration `0063`. |
| E2.1 Phone keys | Done in source: Secure Enclave identity + prekeys rotated every 10 h, private prekeys deleted after retention + 2 h, published with each heartbeat; shared Keychain group for the app and both extensions. |
| E2.2 Key directory | Done in source: migrations `0064`/`0065`, `PUT/GET /api/devices/…/keys`, `PUT /api/clients/self/keys`, `GET /api/clients/keys`. |
| E2.3 CLI trust | Done: `relo keys status · verify · forget · rotate`; verification needs a person at a terminal. |
| E2.4 Phone trust | Done in source: Settings → Security lists computers, shows the safety number, and trusts one only when the owner confirms it. |
| E3.1–E3.2 Sealed notices | Done in source: `relo notify` seals for verified phones; the server stores envelopes and placeholders only; the Notification Service Extension and the app open them. Project and topic names are still metadata (E2.5). |
| E4.2 Signed answers | Done in source: the iPhone signs every answer when it is queued (in the app, from a notification, or from a Live Activity button); once a computer trusts a phone, `relo ask` acts on approved, yes or replied only with a valid signature from a trusted phone, and otherwise exits 4 (do not act). Negative answers need no signature. |
| E4.1 Sealed questions | Done in source: `relo ask` seals the question's title and prompt for verified phones on both the card path and the in-app path; the server stores the placeholder "Encrypted question" and the envelopes; the iPhone opens them in the app and the notification. A card shows the placeholder until E5. Answer button labels stay readable. |
| E4.3 Sealed replies | Not needed for now: new questions take tappable answers only (typed replies were removed). If typed replies return, they must be sealed to a per-question key carried inside the sealed question. |
| E1.2 Card retention | Done in source: the retention window also deletes ended cards (title, status, steps, snapshots) once their events are gone; active cards are never touched (migration `0069`). |
| E1.3 Keyed body digest | Done in source: bodies are digested with a server-keyed HMAC instead of plain SHA-256, and earlier plain hashes are overwritten (migration `0068`). |
| E6.3 Replay protection | Done in source: the iPhone remembers which notification first carried each envelope context, in the shared Keychain, and blocks the same envelope under another notification ("A repeated encrypted message was blocked"). |
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
- **E0.3 — Interop test vectors.** CryptoKit and `@hpke/core` each open the other's envelopes;
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
  Activity buttons. The CLI verifies them before it reports `approved`.
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
