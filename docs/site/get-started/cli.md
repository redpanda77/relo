---
title: Connect this computer
nav: 3. Connect this computer
summary: The relo CLI on this computer, signed in to your server, so its agents and scripts can report to your phone.
---

## What you get

The `relo` CLI is how every agent and script on a computer talks to Relo. It keeps each session's
work, encrypts it for your phones and sends only the changes. Install it once per computer; each
computer gets its own credential that you can revoke on its own.

## The fastest way: one command

Right after you create your account, **Connect a computer** gives you one command with a one-time code
(later: Dashboard **Settings → Computers → Add a computer**, or iPhone **Settings → Devices → Add a computer**).
Run it in a terminal on this computer, or on a server over SSH:

```sh
curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…
```

It installs the CLI your server hands out (and Node.js 22 if this computer has no recent one), signs this
computer in with no sign-in and sets up the agents you picked. Prefer to let your agent do it? The wizard
also gives a prompt for it. See [Connect a computer](/docs/guides/servers).

## Step by step

<ol class="docs-steps">
<li>

**Install the CLI from your server.** It carries the matching agent skill, is checked against its
digest, and installs under `~/.local/share/relo` with a `relo` launcher in `~/.local/bin`:

```sh
curl -fsSL https://relo.example.com/install.sh | sh
relo --version
```

</li>
<li>

**Sign in without a code.** Run the login command with your server's address:

```sh
relo auth login --api-url "https://relo.example.com"
```

The CLI prints a one-time link, a QR code, a code and a two-digit number, and tries to open the link.
Approve in the Relo app (**Settings → Devices → Sign in a computer**: scan the QR code or type the code) or in the
browser, and pick the number the terminal shows. `--no-open` keeps the CLI from opening a browser.

A denied, expired or timed-out request leaves the computer signed out; run the same command again.
After approval, the server address and the credential are kept in a config file only you can read.
No command ever takes a token as a flag.

</li>
<li>

**Check the computer.**

```sh
relo auth status
relo doctor
```

`relo doctor` prints `ready` and, while something is missing, a `next` step with the exact command to
run: sign in, a phone, then the one-time `relo test`.

</li>
</ol>

:::tip CI and containers
A pipeline, or a cloud sandbox such as Claude Code on the web (not a computer), skips the sign-in: set
`RELO_TOKEN` and `RELO_API_URL` from its secret store. See
[Scripts, cron and CI](/docs/guides/scripts).
:::

After the computer joins, restart any agent sessions that were already open.

## Check it

```sh
relo doctor
```

At this point `ready` is still `false`, and `next.step` is `test`: the server and your phone are known,
and the last check is a real card on the phone. That is the next step.

If `next.step` is `login`, the sign-in did not complete; if it is `phone`, open the Relo app, sign in
and allow Live Activities, then confirm with `relo devices list`.

## Several servers or accounts

One computer can hold several sign-ins as profiles (`--profile work`), switched with
`relo auth switch`. See [Profiles](/docs/guides/profiles). To keep the CLI current, see
[Updating](/docs/guides/update).
