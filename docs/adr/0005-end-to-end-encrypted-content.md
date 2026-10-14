# ADR 0005: End-to-end encrypted content

## Status

Accepted (13 October 2026) by the owner: WhatsApp/Signal-style end-to-end encryption, on by
default, with linked devices. The threat model is in
[END-TO-END-ENCRYPTION.md](../END-TO-END-ENCRYPTION.md).

## Context

[ADR 0004](0004-isolated-multi-user-accounts.md) promises that the server admin cannot read an
account. Only the application enforces that promise:

- Content is stored in plaintext, except notification bodies.
- The bodies are sealed with a key derived from the server's own secret.

So anyone holding the database and that secret can read everything, whether that is the operator,
a host, or someone who stole a backup. Content also stays on the server until an operator prunes
it by hand.

## Decision

- **Content is sealed on the sender's machine.** The CLI seals content to device keys held in the
  Secure Enclave of the owner's paired iPhones, using HPKE (RFC 9180) with P-256 and AES-256-GCM.
  The server stores and relays the sealed envelopes. It never holds a key that opens them.
- **The server's view is limited to metadata.** It sees accounts, devices, timing, size buckets,
  state enums, and opaque project and topic handles. Every server decision that reads text today
  moves to explicit metadata that the CLI computes.
- **Trust is automatic.** Following WhatsApp and Signal, by the owner's decision, endpoints trust
  each other's keys on first use. A later key change is accepted and shown as a "security code
  changed" notice. Comparing the security code, and a strict mode that blocks on change, are
  optional.
- **New devices are linked from a trusted phone.** The account's first phone is trusted on first
  use. A later phone, or a web browser, receives sealed content only after a trusted phone approves
  it (one tap, or a QR scan for a browser), so the server cannot add a device of its own.
- **Answers are signed by the device.** The CLI acts on an approval only when the answering
  device's signature verifies against a trusted key.
- **Content is short-lived.** The server deletes content after a configurable window, with 10
  hours recommended. Phones rotate their receiving keys on the same cadence and delete old private
  keys. Deleted content cannot be recovered, and neither can sealed copies made before deletion.
- **Producers without keys are labelled.** Webhooks and server-generated notices cannot be
  end-to-end. Their content stays server-sealed and the phone labels it as not end-to-end
  encrypted.
- **The web Dashboard reads only as a linked browser.** Without a link it shows sealed items as
  locked. A linked browser holds its own non-extractable WebCrypto keys, like WhatsApp Web; the
  accepted cost is that the server delivers the Dashboard's code.

## Consequences

- Reading sealed content in a web browser needs that browser to be linked from the iPhone.
- The server no longer derives tone, grouping, previews or status phrases from text. The CLI and
  phone take over that logic, using shared code in `packages/contracts`.
- Losing every trusted device means losing history. Adding a new device needs approval from a
  trusted phone, or `relo keys verify` when no trusted phone is left.
- Recovering from a single compromised device means revoking that device. Every CLI drops it from
  its recipients.
- The server still learns metadata, and can delay or drop messages. Those risks are accepted and
  documented.

## Addendum (14 October 2026): approving from a linked browser, and simulators

- **A linked browser may approve a new phone.** It signs the same `approve-device` input a phone
  signs, with its `brw_…` id as the approver, from Account → Security → Devices. Only a browser a
  trusted (non-simulator) phone linked in the last 14 days qualifies, with the owner's session and a
  fresh two-step code when that is on. This widens the "server delivers the Dashboard's code" cost
  already accepted for reading: served code could approve a server-added phone. Computers announce
  such approvals, and strict mode refuses them.
- **Simulators never vouch.** A phone in the iOS Simulator is labelled "Simulator", gets no approval
  notices, never approves a real phone, and is never trusted automatically by the CLI.
- **The Dashboard shows who can read.** One Devices list with a plain encryption status per phone,
  computer and browser, and Remove, which deletes what only that device could open.
