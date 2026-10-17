---
title: Privacy and security
nav: Privacy and security
summary: What your agents tell you is readable only on your own devices, and nobody else can answer for you.
---

## Why it matters

Agents work on client code, unreleased plans and personal matters. Scripts handle backups and
deploys. Anything that leaves your computers about that work has to stay yours. Relo is built so the
server, the person who runs it, its backups and Apple's push service carry your content without being
able to read it, and without being able to forge your answers.

## End-to-end encryption

- **Sealed on the computer that sends it.** The `relo` CLI encrypts every card (goal, status, step
  labels, outcome), question and notification before it leaves the computer.
- **Opened only on your devices.** Your iPhone, its Lock Screen card, its notifications and your Apple
  Watch open the content. A browser opens it only after you link it from your iPhone.
- **The server cannot read it, even though it is yours.** It stores and relays sealed envelopes and
  never holds a key that opens them. Someone with the database, a backup or full control of the server
  sees ciphertext and metadata.
- **Names are hidden too.** Project, topic, computer and account names reach the server only as
  opaque handles; the phone shows the real names.
- **Standard cryptography.** HPKE (RFC 9180) with P-256 and AES-256-GCM, and ECDSA P-256 signatures.
  Nothing custom.
- **No setup.** Like WhatsApp and Signal, a computer trusts your first iPhone the first time it sees
  its key. Once a phone has keys, the server refuses readable content from your computers.

:::privacy The phone's identity key never leaves the Secure Enclave
The key that signs your answers is created in the iPhone's Secure Enclave. The keys that receive
content are kept in the Keychain shared by the app and its extensions, never leave the phone and are
replaced every 10 hours.
:::

## Signed answers

When you approve, decline or say yes or no, the phone signs the answer with its identity key, bound to
that exact question and the time it was asked. The CLI acts on an approval only when the signature
verifies against a phone it trusts. A compromised server can delay or drop an answer, but it cannot
approve anything for you or replay an old yes.

:::warning Only approved is permission
`relo ask --approval` gives permission only with exit 0 and state `approved`. A denial, an expired
question, a late answer or any error means no.
:::

## New devices

A phone or computer that appears later cannot read or send on its own:

- **A new phone** waits until a phone you already trust approves it (Settings → Devices), or you run
  `relo keys approve` at a terminal. Until then computers seal nothing to it and refuse its answers.
- **A new computer** shows on your iPhone as "New computer wants access". Nothing it sends opens until
  you approve it.
- **A changed key** (a reinstall, `relo keys rotate`) shows a "security code changed" notice on the
  phone and in `relo keys status`.

Comparing the 60-digit security code (`relo keys verify`) is optional. For a server on a public address,
`relo keys strict on` stops sealing to a phone whose code changed until you verify it again.

## What the server does see

The server always sees metadata:

- which account, phone, browser and computer key is involved
- when something was sent, and its size rounded up to a block
- the kind of message (notification, question or card) and its state: active, ended, approved,
  denied, expired
- the plan's structure (step ids, states and counts), never the step labels
- the name of the agent harness, such as "Claude Code"
- delivery timing

Apple's push service sees the device token, size and timing. Prompts, transcripts and tool calls never
leave your computer, with or without hooks.

:::note What cannot be end-to-end encrypted
Apps and services that call the HTTP API hold no Relo key, so their content is encrypted at rest with
a server key and readable to the server. On an account that requires end-to-end encryption a service may
send only if you allowed it for that service (`relo services edit svc_… --readable on`). Messages the server
writes itself, such as account requests, are readable too. The phone labels these as not end-to-end encrypted.
:::

## Retention and key rotation

- **Server retention.** The server deletes notifications, questions, answers and ended cards after the
  window you set in `RELO_CONTENT_RETENTION_HOURS` ({{fact retention.defaultHours}} by default in the deploy
  files). A question still waiting, an active card and the current item of a topic are kept until they
  settle. If you leave it empty, content is kept until you delete it. `relo doctor` shows the window your
  server runs with.
- **Key rotation.** The phone replaces its receiving key every 10 hours and deletes the old private
  half after the retention window plus two hours. From then on, every envelope sealed to it is
  unreadable, including copies taken before deletion.
- **Losing a phone.** Remove it in the Dashboard (Account → Security → Devices). It drops out of every
  recipient list at once. A new phone starts with an empty history by design.

## You run the server

Relo is self-hosted: one Docker Compose stack on a machine you choose, behind an address you choose.
Each person on the server gets a separate, private account, and the server admin manages accounts
without being able to open them. There is no Relo cloud in the path; the server talks only to Apple's
push service, outbound.

## Read more

- [End-to-end encryption in detail](/docs/concepts/encryption): the keys, the envelope and the trust
  rules.
- [Keys and trust](/docs/guides/keys): approving phones, verifying codes, strict mode.
- [Hardening your server](/docs/guides/hardening): what to do before you put it on a public address.
