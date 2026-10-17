---
title: Set up with your agent
nav: Set up with your agent
summary: Paste one line into Claude Code, Codex, OpenCode or any coding agent and it connects this computer to Relo for you, asking only what it must.
---

## For you

Your server and your iPhone app are ready, and you want this computer connected: the `relo` CLI, a
sign-in, and every agent here (Claude Code, Codex, Gemini CLI, Cursor and the rest) told about Relo
with its skill and instructions. Paste this into your agent, with your server's address:

```text
Read https://relo.example.com/install.md and set up Relo on this computer.
```

Works the same in OpenCode. Better: **Connect a computer** in the Relo app or Dashboard gives you this prompt with a one-time code
in it (`install.md?code=rci_…`), so the agent never needs you to sign in. Without a code, the agent
asks you to approve the sign-in in the Relo app. It takes about five minutes.

No server or iPhone app yet? Start with [Run the server](/docs/get-started/server) and
[Install the iPhone app](/docs/get-started/iphone), then come back.

## For the agent

You are a coding agent setting up Relo for the owner on this computer. Relo shows the work of their
agents, scripts and apps on their iPhone and asks them before risky steps. Do the steps below in
order. Each one starts with a check: skip what is already done. Tell the owner in a sentence what you
are about to do before each step that changes the computer, and what you found after it.

- **The server** is the origin of the address you read this page from (`https://relo.example.com` in
  the examples below). If you were given this page without an address, ask the owner for their Relo
  server's address.
- **Prefer a code.** If the owner has a Connect a computer prompt, ask for it (or its code): fetch
  `/install.md?code=<code>` from the server and follow that page, which runs the install with the code.
  Otherwise do the steps below, and sign in with `relo auth login`.
- **Cloud sandbox?** If this is a cloud sandbox (Claude Code on the web, Codex cloud), it is not a
  computer: do not install. Tell the owner to use a CI token (`RELO_API_URL` and `RELO_TOKEN`).
- **Never** handle a token or password: the sign-in is approved by the owner in their browser. Never
  put a token on a command line or in a file.
- **The full docs** for anything this page does not cover: `/llms.txt` on the same server lists every
  page as Markdown. Troubleshooting: `/docs/troubleshooting.md`.

### 1. Check the computer

Find the operating system (macOS, Linux or Windows) and whether Node.js 22 or newer is installed:

```sh
node --version
relo --version
```

Node.js is not required: the install below brings Node.js 22 for Relo when the computer has no recent one.

### 2. Install the CLI

Skip this if `relo --version` already printed a version; `relo update` brings it to the version the server
hands out if the owner wants that. Otherwise install it from the owner's server (checked against its
digest; nothing runs as root):

```sh
curl -fsSL https://relo.example.com/install.sh | sh
relo --version
```

The `relo` launcher goes in `~/.local/bin`; if that is not on this shell's `PATH` yet, call it as
`~/.local/bin/relo` until a new shell starts.

### 3. Sign in

```sh
relo auth status
```

If it is not signed in to this server, start the browser sign-in with a name for this computer:

```sh
relo auth login --api-url "https://relo.example.com" --client-name "<this computer's name>"
```

In an agent it does not block: it prints a `url`, a `code`, a two-digit `number` and a `qr` (the link
as a QR code). Show the owner all of them, the QR code in a code block, and tell them the number and
where to approve: in the Relo app on their iPhone (**Settings → Devices → Sign in a computer**, scan the QR code
or type the code), or by opening the link in a browser. They pick the number the terminal shows. Then
wait for it:

```sh
relo auth login --wait
```

Exit 4 means it is still pending: run it again. A denied or expired sign-in leaves the computer
signed out; start again.

### 4. Ask the owner two things

Ask both in one message, with the recommended answers, and go on with those if the owner says so:

- **Where should agents learn about Relo?** Recommended: for every agent on this computer (each
  harness's own instructions file and its skill). Alternative: only this repository (`AGENTS.md`, and
  a `CLAUDE.md` that imports it).
- **How deep should Relo plug into your agents?** Offer these four lines, track recommended:

  ```text
  1  notify     Questions and notifications only. No cards.
  2  track      Live cards with plans on your phone.            (recommended)
  3  guide      Track, plus continuity across requests, compaction and /clear,
                and which sessions are working (hooks).
  4  optimize   Guide, plus lean context and right-sized subagents.
  ```

  At guide or optimize, also ask whether permission prompts may be answered from the phone
  (`--approvals on`). No prompt or tool content ever leaves the computer.

### 5. Tell the agents

Show the owner the plan first, then apply it with their answers:

```sh
relo setup --dry-run --level track
relo setup --level track
```

Use the depth the owner chose in place of `track`. For this repository only, add `--project`. Setup
writes a short marked block into each harness's instructions file (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md` and the others), installs the Relo skill at this CLI's version (except at notify), and
prints what it changed and skipped. Tell the owner that summary.

### 6. Check and send the first card

```sh
relo doctor
```

Follow `next.run` for the first unmet step and ask the owner where it needs them:

- `phone`: the owner opens the Relo app on their iPhone, signs in to the same server and allows
  Live Activities. Then run `relo doctor` again.
- `test`: run `relo test`. A card asks "Can you see this card?" on the phone; the owner taps Yes.
  If it stops before the owner answers, run it again.

Done when `relo doctor` prints `ready: true`.

### 7. Finish

Tell the owner what you did in a few lines: the CLI version, the server, the harnesses set up and the
depth. Tell them to restart their agent sessions, since a session that was open before setup does
not see the new instructions. In the next one, they can say:

> Use Relo to keep a live view of this task on my iPhone.

To undo everything later, `relo uninstall` lists what Relo wrote and `relo uninstall --apply` removes
it.
