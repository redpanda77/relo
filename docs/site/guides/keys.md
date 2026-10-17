---
title: Keys and phones
summary: See which phones can read your content, approve a new one, compare security codes, and tighten the rules when you want to.
---

Everything a computer sends is sealed to your phones before it leaves, so the server, and anyone who
breaks into it, cannot read it. You do not have to do anything for that to work: each computer
trusts your phones the first time it sees them, the way WhatsApp and Signal do. These commands are
for when you want to look, or decide for yourself. How sealing works:
[Encryption](/docs/concepts/encryption). Every command: [relo keys](/docs/reference/cli/keys).

## See what this computer trusts

```sh
relo keys status
```

It lists this computer's identity and each phone on the account: its name and model, a short handle
(such as `iphone-air`), when it was last seen, and its trust:

| Trust | Meaning |
| --- | --- |
| `auto` | trusted on first use; content is sealed to it |
| `verified` | you compared its security code |
| `approved` | you approved it by hand with `relo keys approve` |
| `pending` | a phone that waits for approval; nothing is sealed to it yet |
| `changed` | its security code changed and strict mode (or a simulator) holds it |

A notice such as "security code changed" or "phone set up again" says what happened. It also shows
whether the account requires encryption.

## Approve a new phone

Your first phone is trusted on first use. A phone that signs in after it waits as *pending*:
computers seal nothing to it and refuse its answers, so someone with your password cannot add a phone
of their own. Approve it in one of three places:

- **On a trusted iPhone**: it gets a notification that the new phone wants to read your cards. Open
  Settings → Devices and tap **Approve** (or **Decline**, which signs it out).
- **In the Dashboard**, from a browser linked to a trusted phone: Account → Security → Devices.
- **At this computer's terminal**:

```sh
relo keys approve iphone-air
```

It shows the phone's name, model, when it signed in and the start of its security code, then asks
`[y/N]`. Use the handle or the `dev_…` id from `relo keys status`. An approval on a trusted phone
reaches every computer on its own; `relo keys approve` approves the phone for this computer only.

## Verify a security code

Optional, for when you want certainty that no one is in the middle:

```sh
relo keys verify iphone-air
```

Compare the 60-digit code with Settings → Devices → Verify security code on the iPhone. If they
match, confirm: the phone becomes `verified`.

## Strict mode

By default a changed key (a reinstall, a new phone after every trusted one left) is trusted again
with a visible notice. That keeps things working, but it means a compromised server, or someone with
your password, could swap in a phone key of its own and you would see only the notice. Strict mode
holds such a phone until you verify it:

```sh
relo keys strict on
```

On a server with a public address it is already on, and the first command after that says so once: strict mode follows the address until you choose
(`relo keys strict on`, `off`, or `auto` to let the address decide again). In strict mode a linked browser cannot
approve a phone either; only a trusted phone or `relo keys verify` can. Nor does a browser's answer to
a question count: only a phone's signed answer does.

## Require encryption

Once a phone of the account has keys, the account requires sealing automatically (`auto`): the
server refuses readable notices, questions and card text from CLI logins with `end_to_end_required`.
`relo keys require on` requires it even before. A CLI cannot turn the requirement off: that takes
you, signed in to the Dashboard (Account → Security). Webhook services and messages the server
writes itself cannot be sealed; they are labelled as readable.

## Replace or forget a key

| Command | When |
| --- | --- |
| `relo keys rotate` | replace this computer's identity key, for example if the config folder was copied. Your phones show a security code change. |
| `relo keys forget DEVICE_ID` | drop one phone's pinned key on this computer; it is trusted again the next time it is seen |
| `relo keys remove PHONE` | prints where to remove a phone: a computer cannot sign one out. Remove it in the Dashboard (Account → Security → Devices), which also deletes what only that phone could open. |

## Lost a phone

Remove it in the Dashboard (Account → Security → Devices). It can no longer read anything, and what
only it could open is deleted. Your other phones and computers keep working.
