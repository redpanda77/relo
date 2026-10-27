---
title: Connect this computer
nav: 2. Connect this computer
summary: Right after you create the owner account, one line in a terminal or one message to your agent connects this computer, signs it in and sets up its agents.
---

## What you get

The `relo` CLI is how every agent and script on a computer talks to Relo. It keeps each session's
work, encrypts it for your phones and sends only the changes. Install it once per computer; each
computer gets its own credential that you can revoke on its own.

You do not install it by hand. The moment you create the owner account, the Dashboard opens
**Connect a computer**, a wizard in five steps that hands you one line for this computer. The first
computer you connect needs no approval from a phone: the iPhone comes next, in
[step 3](/docs/get-started/iphone).

## Connect a computer

The wizard shows **Step 1 of 5** at the top. Later, open it again from **Account → Computers → Add a
computer**.

<ol class="docs-steps">
<li>

**Connect a computer.** Choose who runs it:

- **I'll run a command:** paste one line into a terminal on the computer.
- **Let my agent do it:** paste one message into Claude Code, Codex, OpenCode or another agent on the
  computer.
- **My computer shows a code:** for a computer that already ran `relo auth login` and shows a code.
  Type it under **Code on the computer** and press **Open the approval page**.

For a command or a prompt, pick **How much Relo does there**: **Notify** (questions and notifications
only), **Track** (live cards with plans, recommended and the default), **Guide** (track, plus sessions
and continuity) or **Optimize** (guide, with lean context). See [Depth and hooks](/docs/guides/hooks).
**Options** holds the rest:

- **Ask permission on my iPhone too** relays your agents' permission prompts to the phone (guide and
  optimize).
- **On a Mac, also install Relo for Mac in the notch** is on by default; anything but a Mac skips it.
- **Agents to set up:** **Every agent it finds**, or **Only the ones I pick**.

Press **Make the command** (or **Make the prompt**).

</li>
<li>

**Run it on your computer.** Copy the line and paste it into a terminal on this computer, as the user
your agents run as. It works once, for 30 minutes:

```sh
curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…
```

It installs Node.js 22 if the computer has no recent one, then the CLI your server hands out (checked
against its digest) under `~/.local/share/relo`, with a `relo` launcher in `~/.local/bin`. It signs the
computer in with the code, with no browser sign-in, and runs `relo setup` with the depth and agents you
chose. Nothing runs as root. The wizard follows along: **Waiting for your computer…**, then
**_name_ connected** and **Setting up its agents…**. **Close, keep waiting** lets it finish in the
background; **Account → Computers** offers **Resume**.

If the code expires first, press **New command**.

</li>
<li>

**Your agents.** Each agent the computer found shows as connected, at its depth. One that was found but
not connected comes with its own command (`relo setup --agent <id>`). Restart the agents that were
already open, so they load Relo; a session open before setup does not see it.

</li>
<li>

**Send a test.** The computer sends you a first notification when it finishes setting up. Nothing after
a minute? Send one from that computer:

```sh
relo notify "Relo is set up"
```

With no iPhone yet, the wizard says **Install the iPhone app to see it**: that is the next step, and
**Continue without a test** finishes this one.

</li>
<li>

**Get the apps.** **Relo for iPhone** shows your cards on the Lock Screen and asks you before anything
risky. **Relo for Mac** puts the same status in the notch. Press **Done**.

</li>
</ol>

### Let my agent do it

The prompt carries the code and your depth, so the agent never asks you to sign in:

```text
Read https://relo.example.com/install.md?code=rci_… and set up Relo on this computer at the track level. It sends me a first notification when it is done.
```

The agent reads the page your server serves at `/install.md` and runs the same one-line install. Its
harness may ask you to allow the command. If it has not picked the code up after two minutes, the wizard
offers **Run it yourself instead**: the same code, as a command. Without a code, the same page walks an
agent through a browser sign-in: [Set up with your agent](/docs/get-started/with-an-agent).

### Windows

On Windows the wizard's **Windows** choice shows a PowerShell line instead:

```powershell
& ([scriptblock]::Create((irm https://relo.example.com/install.ps1))) rci_…
```

It installs for your user alone (no administrator): Node.js 22 if needed, the CLI your server hands out
(checked against its digest) under `%LOCALAPPDATA%\Relo`, a `relo.cmd` launcher, and your user `PATH`. With
the app option on, the line ends in `-WindowsApp` and also installs **Relo for Windows**, opened already
signed in. A server with no Windows app to hand out says so and skips it.

### Relo for Mac

On a Mac, with the Mac option on, the line ends in `--mac-app`: it also installs **Relo for Mac** in
`~/Applications` (checked against its digest) and opens it in the notch already signed in. A server
with no Mac app to hand out says so and skips it. See [Connect a computer](/docs/guides/servers).

## By hand

Without the wizard, install the CLI from your server and sign in with a browser:

<ol class="docs-steps">
<li>

**Install the CLI.**

```sh
curl -fsSL https://relo.example.com/install.sh | sh
relo --version
```

</li>
<li>

**Sign in.** Run the login command with your server's address:

```sh
relo auth login --api-url "https://relo.example.com"
```

The CLI prints a one-time link, a QR code, a code and a two-digit number, and tries to open the link.
Approve in the browser where you are signed in (or in the Dashboard: **Connect a computer → My computer
shows a code**; once you have the iPhone app, **Settings → Devices → Sign in a computer**), and pick the
number the terminal shows. `--no-open` keeps the CLI from opening a browser.

A denied, expired or timed-out request leaves the computer signed out; run the same command again.
After approval, the server address and the credential are kept in a config file only you can read.
No command ever takes a token as a flag.

</li>
<li>

**Set up the agents** with `relo setup`, as in [Tell your agents](/docs/get-started/agents).

</li>
</ol>

:::tip CI and containers
A pipeline, or a cloud sandbox such as Claude Code on the web (not a computer), skips the sign-in: set
`RELO_TOKEN` and `RELO_API_URL` from its secret store. See
[Scripts, cron and CI](/docs/guides/scripts).
:::

## Check it

```sh
relo auth status
relo doctor
```

`relo doctor` prints `ready` and, while something is missing, a `next` step with the exact command to
run. At this point `ready` is still `false` and `next.step` is `phone`: no iPhone is signed in yet. That
is the next step. If `next.step` is `login`, the sign-in did not complete.

## Several servers or accounts

One computer can hold several sign-ins as profiles (`--profile work`), switched with
`relo auth switch`. See [Profiles](/docs/guides/profiles). To keep the CLI current, see
[Updating](/docs/guides/update).
