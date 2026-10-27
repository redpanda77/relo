---
title: End-to-end encryption
nav: Encryption
summary: What your agents, scripts and apps tell you is sealed on the computer that sends it and opens only on your phones; your own server cannot read it or forge your answers.
---

Agents work on client code, unreleased plans and personal matters. Relo is built so that the words
they send you are readable only on your devices. The server you run, its database, its backups and
Apple's push service carry the content without being able to read it, and they cannot forge it or
your answers. It works automatically: nobody has to compare keys.

Relo for Mac running on its own: nothing leaves the Mac, so nothing is encrypted and no phone is involved.

## Keys

| Key | Where it lives | What it does |
| --- | --- | --- |
| Computer identity | the CLI's config folder on each computer, readable only by you | signs everything that computer sends |
| Phone identity | your iPhone's Secure Enclave; it never leaves the chip | signs your answers and approves new phones |
| Phone prekeys | the iPhone's Keychain, shared only by Relo and its extensions (the Lock Screen widget reads a private copy kept in Relo's own container, since a widget has no Keychain) | receive sealed content; a new one every 10 hours |

The server stores public halves only. A phone deletes each old prekey's private half shortly after
the server's content retention window has passed. From then on, nothing sealed to that prekey can
be opened again, including any copy taken earlier.

## Trust on first use

Like WhatsApp and Signal, Relo trusts a key the first time it sees it, so encryption starts at once:

- your computers trust the account's first phone, and the phone trusts the computers already on
  the account;
- a reinstall or a rotated key is trusted again automatically and leaves a visible "security code
  changed" notice in `relo keys status` and on the phone's Settings → Devices;
- verifying is optional: `relo keys verify` and the phone show the same 60-digit security code.

A phone you set up again is trusted again, as WhatsApp does after a reinstall: signing out keeps the
phone's own keys, so the same phone signing back in is recognised with no notice. If every phone a
computer trusted has left the account, the new phone is trusted and every command says "your phone was
set up again" for a week. A server that removes your phone and adds its own gets that visible notice,
not a block; strict mode holds the new phone until you verify it.

The trade-off is the usual one: a server that is malicious at the very moment a device is first
seen could present its own key. Every later substitution shows up as a change. Verify once, or use
strict mode, if you want more.

## New phones and computers wait for your approval

A phone that signs in after your first one is **pending**. Your computers seal nothing to it and
refuse its answers until a phone they already trust approves it, in Settings → Devices. You can also
approve it from a linked browser or with `relo keys approve` at a terminal. A computer that joins
later is pending on your phones in the same way. Your server cannot add a phone of its own, and
neither can someone who only knows your password.

**Key binding.** When you connect a computer with a code, the wizard approves its key for you, so
you tap nothing. The code has a second half that never reaches the server. The computer proves with
it that the key it publishes is its own, and the device that made the code checks that proof before
it approves. A key your server swapped in fails the check. If the code came from another device or
the wizard was closed, the computer waits for the ordinary approval.

**Sign-in number.** `relo auth login` without a code makes the computer's key first, then prints a
two-digit number worked out from that key and the sign-in code. Your phone or browser works out the
number itself from the key it is shown and offers it among two decoys. Picking the number the
terminal shows ties your approval to that computer's key, so the server cannot swap one in.

## Who you are protected from

| Who | What they get |
| --- | --- |
| Someone with a database dump, a backup or a stolen disk | Ciphertext and metadata. Expired content is gone, and older ciphertext cannot be opened once the phone rotates its keys. |
| Whoever runs your server, even with modified code | No content, and no way to forge content or your answers. They can still see metadata, delay or drop messages, and deny service. A phone they add stays pending, and a computer that cannot seal fails instead of sending readable text. |
| Apple's push service | Ciphertext, the device token, size and timing. |
| Another account on the same server | Nothing, as before; encryption backs this up. |
| An attacker on the network | Nothing beyond TLS. |
| A compromised, unlocked iPhone or computer | Out of scope: a device has to read the content to show it. |

Sizes are padded to buckets. Timing is not hidden.

## What is sealed and what the server sees

:::privacy What is sealed
The goal, status, waiting reason, step labels and outcome of every work; the text of questions and
their detail; the text of notifications; the names of projects, topics, computers, accounts and
sessions.
:::

Your server still needs some structure to do its job, and sees it:

- which account, device and computer key is involved, and when;
- the kind of message (notice, question or card) and its padded size;
- the plan's structure: step ids, which step is current, counts;
- states: open, finished, approved, denied, expired;
- opaque handles in place of project and topic names, so it can group without reading;
- answer button labels and the few words it writes itself ("Approved", "Expired").

Apple's push service sees ciphertext, the device token, size and timing.

## Signed answers

When you tap Approve, Yes or an option, your phone signs the answer with its Secure Enclave key,
bound to that exact question and to the envelope it actually opened. The CLI accepts an approval only
when that signature verifies against a phone it trusts. A compromised server can delay or drop an
answer, but cannot invent one, replay an old approval or show you a different question. A linked
browser signs its answers the same way with its own key; the CLI accepts them only outside strict mode
and only while a phone it trusts linked that browser in the last 14 days. See
[questions](/docs/concepts/questions).

## The producer's own sealed copy

Because the server cannot read a work's text, each computer also uploads its own copy of the goal,
status and step labels, sealed under a key only that computer holds. The server returns it only to
the same session (or the same script producer key). If the computer loses its local state, the CLI
rebuilds its working copy from it.

## Linked browsers

Signing in to the Dashboard alone gives a browser no keys. A browser reads sealed content only once
you link it by scanning its QR code with Relo on a trusted iPhone (Settings → Devices). Unlinked, it
shows a lock and "open on iPhone to read". A linked browser can also approve a new phone and answer
questions, signed with its own key. The server delivers the Dashboard's code, so a linked browser is a
step below a phone in trust, as with WhatsApp Web: strict mode turns its approvals and answers off.

## Required encryption and strict mode

Relo for Mac running on its own: nothing leaves the Mac, so nothing is encrypted and no phone is involved; none of this applies there.

- **Required, automatically.** Once any active phone on your account has keys, your server refuses
  readable work text, questions and notifications from your computers. If a computer cannot seal, the
  command fails and nothing is sent; it never falls back to readable text. `relo keys require on|auto|off`
  changes the policy; turning it off needs you signed in to the Dashboard (Account → Security).
- **Strict mode.** It stops sealing to a phone whose security code changed, or that was set up again
  after every trusted phone left, until you verify it, and refuses a linked browser's phone approvals
  and answers. It is on by default for a computer signed in to a server on a public address and off on a
  private network; `relo keys strict on|off|auto` changes it (see [keys and devices](/docs/guides/keys)
  and [hardening](/docs/guides/hardening)).

## What cannot be end-to-end encrypted

Webhook services and apps posting over HTTP hold no Relo key and cannot seal, and messages your server
writes itself (access requests, the "Relo needs you" fallback, the Test Lab) are written there. Both are
encrypted at rest with your server's own key, which means your server can read them, and the phone labels
them *Not end-to-end encrypted*. When encryption is required, a service is refused unless you allowed
readable content for it: `relo services edit svc_… --readable on` (services created before this rule are
allowed; new ones are not). See [apps](/docs/guides/apps).

The web Dashboard cannot read sealed items unless you link the browser, because your server delivers its
code. Unlinked, it shows a lock and tells you to open the item on the iPhone.

## Retention and losing a phone

Content is deleted from the server after a retention window you set (`RELO_CONTENT_RETENTION_HOURS`; 10 hours
is recommended): notification history, questions, replies and ended cards go, while pending questions and
active cards stay. Your phone keeps its own history in file-protected caches under its own retention
setting, and text that has expired on both sides shows as *Expired*. See [hardening](/docs/guides/hardening).

A new phone starts with empty history, on purpose: the content was disposable and has expired. It is
trusted once a phone you already have approves it, and removing the old phone takes it off every recipient
list at once. How to check and manage keys: [keys and devices](/docs/guides/keys). The exact formats are in
the [encryption protocol](https://github.com/redpanda77/relo/blob/main/docs/ENCRYPTION-PROTOCOL.md).
