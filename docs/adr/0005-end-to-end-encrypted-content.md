# ADR 0005: End-to-end encrypted content

## Status

Proposed (13 October 2026). It becomes Accepted when the owner signs off on the threat model in
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
- **Answers are signed by the device.** The CLI acts on an approval only when the answering
  device's signature verifies against a trusted key.
- **Content is short-lived.** The server deletes content after a configurable window, with 10
  hours recommended. Phones rotate their receiving keys on the same cadence and delete old private
  keys. Deleted content cannot be recovered, and neither can sealed copies made before deletion.
- **Producers without keys are labelled.** Webhooks, server-generated notices and the web
  Dashboard cannot be end-to-end. Their content stays server-sealed and the phone labels it as not
  end-to-end encrypted. The Dashboard shows sealed items as metadata only.

## Consequences

- Reading content in a web browser is no longer possible for sealed items. The iPhone is where you
  read.
- The server no longer derives tone, grouping, previews or status phrases from text. The CLI and
  phone take over that logic, using shared code in `packages/contracts`.
- Losing every trusted device means losing history. Adding a new device needs cross-signing or
  safety-number verification.
- Recovering from a single compromised device means revoking that device. Every CLI drops it from
  its recipients.
- The server still learns metadata, and can delay or drop messages. Those risks are accepted and
  documented.
