---
title: Get Relo on your Mac
nav: Get Relo on your Mac
summary: Download Relo for Mac and your agents' work shows in the notch, private on this Mac. No server to run, no account, nothing leaves the Mac.
---

## What you get

Your agents' work, in the notch. A card for each session, a plan that grows, and a question with buttons
before anything risky, all at the top of your screen, where you already look.

It is private by design. Relo runs on this Mac, and nothing leaves it: no account, no cloud, no server
to look after. It is the easiest way to start. You can add an iPhone later by
[connecting a server](#leave-relo-on-this-mac-for-a-server).

## Install

Requires macOS 14 or later on a Mac with Apple silicon.

1. Download **Relo for Mac** from the Relo site (the **Download for Mac** button on its home page). A Relo
   server you build yourself from the public repository doesn't carry the app.
2. Open the download and drag **Relo** to **Applications**. Move it there before you open it, not from the
   disk image or Downloads.
3. Open **Relo** from Applications.

The first time, macOS asks whether you want to open an app you downloaded. Choose **Open**.

## First launch

A Welcome page comes first. Choose **Get started**, then **Continue** on the page that says what Relo does.
Relo then asks **How do you want to run Relo?**

- **Run Relo on this Mac.** Relo starts with your Mac and sets up your agents. Nothing leaves it.
- **Connect to a server.** Sign in to a Relo server you already have, and reach it from your iPhone. See
  [Connect to a server](#connect-to-a-server).

Choose the first one. Relo shows five steps, and each one is ticked as it finishes:

<ol class="docs-steps">
<li>

**Starting Relo.** Relo starts in the background. This takes a few seconds.

</li>
<li>

**Choosing your agents.** A ticked list of the agents Relo found on this Mac: Claude Code, OpenCode and
others. Untick any you want left alone. Relo adds a few lines to their instructions so they report here.
Choose **Continue**, or **Skip agents for now** to set them up later. If Relo finds none, it says so and
moves on.

</li>
<li>

**Adding the relo command.** Relo puts `relo` in `~/.local/bin` and makes that folder reachable from your
terminal, so your agents and you can use the relo command.

</li>
<li>

**Setting up your agents.** Relo links this Mac to Relo running on it, with no password to type, and
writes its lines into the agents you left ticked.

</li>
<li>

**Done.** Relo says "Relo runs on this Mac. Nothing leaves it." and "A test card is waiting in the notch:
answer it there." Answer the test card in the notch, so you see the whole path work, then choose
**Continue**. Restart any agent that was already running, so it reads its new instructions.

</li>
</ol>

If a step fails, Relo says why. **Try again** runs it again from where it stopped, and **Show details**
opens Relo's logs in Finder. If macOS asks you to approve Relo, turn it on under **Login Items** in System
Settings; the **Open Login Items** button on that screen takes you there.

The last page says **You're set**. It tells you how to reach Relo from now on and has a switch,
**Open Relo when this Mac starts**, and two buttons: **Settings** and **Open Relo**.

## What it sets up and where it lives

- **A background service.** It starts when you log in, as a login item named **Relo**. It listens only on
  this Mac, so nothing else on your network can reach it. Because nothing leaves the Mac, it needs no
  encryption keys.
- **Your data,** in `~/Library/Application Support/Relo/server`. Its logs are in the `logs` folder
  there.
- **The `relo` command,** at `~/.local/bin/relo`.
- **A few lines in each agent's instructions,** plus the Relo skill, for the agents you left ticked.

## Open Relo again

The notch is where cards and questions appear: hover it to open it. A Mac without a notch gets one drawn
at the top of the screen. You can also use the Relo icon in the menu bar (**Open in Notch** or **Open
Relo**) or the Dock icon, which opens Relo's window. **Settings…** is in the menu bar menu too.

## Check it

Open a new terminal window first, so it picks up the relo command. Then run the doctor:

```sh
relo doctor
```

It checks that Relo is running, that this Mac is linked and that your agents are set up. To see the test
card again, run:

```sh
relo test --again
```

The notch asks "Can you see this card in your Mac's notch?". Click **Yes**. If nothing appears, see
[Troubleshooting](/docs/troubleshooting).

Or let an agent check for you. Paste this into Claude Code, OpenCode or another agent:

```text
Check that Relo is set up: run relo doctor --json, then relo test, and tell me what you find.
```

## Settings

Open **Settings** and choose **Relo** in the sidebar. On a Mac that runs Relo itself, the group **Relo on
this Mac** shows whether Relo is running and its version, and has:

- **Set up agents again**, to choose which agents report to Relo.
- **Use another Relo server…**, to stop Relo on this Mac and sign in to a server of yours.
- **Uninstall Relo from this Mac…**.

On a Mac signed in to a server, **Settings → Relo** has **Run Relo on this Mac instead…**, which moves
your agents back to this Mac, and an **Encryption** row. Choose **Automatic** (on once an iPhone is
trusted) or **Always** there. Turning encryption off is done in the Dashboard: **Turn off in the
Dashboard** has an **Open** button.

## Updates

Relo for Mac checks for updates on its own. When one is downloaded, the notch (when open) and Relo's
window say "Relo <version> is ready" with **Restart now** and **Later**, and the menu bar menu shows
"Restart to update to <version>". With **Install updates automatically** off, they say "Relo <version> is
available" with **Update**. A critical update says "Important update". **Later** hides the reminder for
a day. After an update, Relo says "Updated to <version>" and refreshes the Relo instructions in your
agents' files, so they match the new version.

## Connect to a server

Relo for Mac can show the cards of a server you run, instead of running Relo itself. Choose **Connect to
a server** on the first screen, or **Use another Relo server…** in Settings.

- Type your server's full address in the field, for example `relo.example.com` or
  `http://192.168.1.5:8180`, and choose **Use**.
- Choose **Sign in**. It opens in your browser. Choose **Later** to skip it; the menu bar and Settings
  can sign in at any time.

Once signed in, the Mac shows your server's cards. It does not install the relo command or set up your
agents: use **Add a computer** in the server's Dashboard for that.

## Leave Relo on this Mac for a server

You can start on this Mac and add a server when you need one:

- **Your iPhone, away from home.** Cards and questions on your Lock Screen need a server your phone can
  reach.
- **Several computers.** One server shows the work of every computer in one place.

First run your server with [Run the server](/docs/get-started/server). Then open **Settings → Relo →
Relo on this Mac → Use another Relo server…** and sign in. Your agents report to that server after you
choose **Add a computer** in its Dashboard. Add your phone with [Add your iPhone](/docs/get-started/iphone);
more computers are covered in [Connect a computer](/docs/guides/servers).

## Uninstall

Open **Settings → Relo → Relo on this Mac → Uninstall Relo from this Mac…**. It removes the setup in your
agents' instructions, the background service and the `relo` command. It asks whether to delete your data
too. Then drag **Relo** from Applications to the Trash.
