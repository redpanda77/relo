---
title: relo keys
summary: Every command that shows, approves, verifies and replaces the end-to-end encryption keys on this computer.
---

Encryption works without any of these commands: this computer trusts your phones the first time it
sees them, and seals everything to them. `relo keys` is for when you want to look or decide: see each
phone's trust, approve a phone that waits, compare a security code, turn on strict mode or require
encryption for the account. Several of them refuse to run without a person at a terminal. When to use
which: [Keys and phones](/docs/guides/keys); how sealing works: [Encryption](/docs/concepts/encryption).

```sh
relo keys status
relo keys verify iphone-air
```

## Commands

{{cli keys}}
