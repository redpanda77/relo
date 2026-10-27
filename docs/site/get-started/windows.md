---
title: Get Relo on your Windows PC
nav: Get Relo on your Windows PC
summary: Download Relo for Windows and your agents' work shows in the notch, private on this PC. No server to run, no account, nothing leaves the PC.
---

## What you get

Your agents' work, in the notch. A card for each session, a plan that grows, and a question with buttons
before anything risky, all at the top of your screen, where you already look.

It is private by design. Relo runs on this PC, and nothing leaves it: no account, no cloud, no server
to look after. It is the easiest way to start. You can add an iPhone later by
[connecting a server](#leave-relo-on-this-pc-for-a-server).

## Install

Requires Windows 10 version 1809 or later, or Windows 11, on a 64-bit PC with an Intel or AMD processor.
It installs for you alone: no administrator prompt.

1. Download **Relo for Windows** from the Relo site (the **Download for Windows** button on its home page).
   A Relo server you build yourself from the public repository doesn't carry the app.
2. Run the download. It installs Relo in `%LOCALAPPDATA%\Programs\Relo` and adds **Relo** to the Start menu.
3. Open **Relo** from the Start menu.

If Windows SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. Run Relo as
yourself, not "as administrator": Relo asks you to open it again if you do.

## First launch

A Welcome page comes first. Choose **Begin**. Relo asks **When something happens** (**Silent**, **Sounds** or
**Voice**), then **Continue**. Relo then asks **How do you want to run Relo?**

- **Run Relo on this PC.** Relo starts with your PC and sets up your agents. Nothing leaves it.
- **Connect to a server.** Sign in to a Relo server you already have, and reach it from your iPhone. See
  [Connect to a server](#connect-to-a-server).

Choose the first one. Relo shows five steps, and each one is ticked as it finishes:

<ol class="docs-steps">
<li>

**Starting Relo.** Relo starts in the background. This takes a few seconds.

</li>
<li>

**Choosing your agents.** A ticked list of the agents Relo found on this PC: Claude Code, OpenCode and
others. Untick any you want left alone. Relo adds a few lines to their instructions so they report here.
Choose **Continue**, or **Skip agents for now** to set them up later. If Relo finds none, it says so and
moves on.

</li>
<li>

**Adding the relo command.** Relo puts `relo` in `%LOCALAPPDATA%\Relo\bin` and makes that folder reachable
from your terminal, so your agents and you can use the relo command.

</li>
<li>

**Setting up your agents.** Relo links this PC to Relo running on it, with no password to type, and
writes its lines into the agents you left ticked.

</li>
<li>

**Done.** Relo says "Relo runs on this PC. Nothing leaves it." and "A test card is waiting in the notch:
answer it there." Answer the test card in the notch, so you see the whole path work, then choose
**Continue**. Restart any agent that was already running, so it reads its new instructions.

</li>
</ol>

If a step fails, Relo says why. **Try again** runs it again from where it stopped, and **Show details**
opens Relo's logs in File Explorer. If Windows will not let Relo run in the background, Relo says so; the
background service is a task named **Relo Server** in Task Scheduler, under your own account.

The last page says **Ready**. It has two switches, **Install updates automatically** and **Open Relo when this
PC starts**, and one button: **Start**.

## What it sets up and where it lives

- **A background service.** It starts when you sign in to Windows, as a Task Scheduler task named **Relo
  Server** (if Windows refuses a task, a `Run` entry for your account does the same). It listens only on
  this PC, so nothing else on your network can reach it. Because nothing leaves the PC, it needs no
  encryption keys.
- **Your data,** in `%LOCALAPPDATA%\Relo\server`. Its logs are in the `logs` folder there.
- **The `relo` command,** at `%LOCALAPPDATA%\Relo\bin\relo.cmd`, with a `relo` sibling for Git Bash.
- **A few lines in each agent's instructions,** plus the Relo skill, for the agents you left ticked.

## Open Relo again

The notch is where cards and questions appear: hover it to open it. A PC without a notch gets one drawn
at the top of the screen. You can also use the Relo icon in the notification area (**Open in Notch** or
**Open Relo**), which opens Relo's window, or the Start menu. **Settings…** is in the icon's menu too.

## Check it

Open a new terminal window first, so it picks up the relo command. Then run the doctor:

```sh
relo doctor
```

It checks that Relo is running, that this PC is linked and that your agents are set up. To see the test
card again, run:

```sh
relo test --again
```

The notch asks "Can you see this card in the Relo notch?". Click **Yes**. If nothing appears, see
[Troubleshooting](/docs/troubleshooting).

Or let an agent check for you. Paste this into Claude Code, OpenCode or another agent:

```text
Check that Relo is set up: run relo doctor --json, then relo test, and tell me what you find.
```

## Settings

Open **Settings** and choose **Relo** in the sidebar. On a PC that runs Relo itself, the group **Relo on
this PC** shows whether Relo is running and its version, and has:

- **Set up agents again**, to choose which agents report to Relo.
- **Use another Relo server…**, to stop Relo on this PC and sign in to a server of yours.
- **Uninstall Relo from this PC…**.

On a PC signed in to a server, **Settings → Relo** has **Run Relo on this PC instead…**, which moves your
agents back to this PC.

## Updates

Relo for Windows checks for updates on its own. When one is downloaded, the notch (when open) and Relo's
window say "Relo <version> is ready" with **Restart now** and **Later**. With **Install updates
automatically** off, they say "Relo <version> is available" with **Update**. After an update, Relo
refreshes the Relo instructions in your agents' files, so they match the new version.

## Connect to a server

Relo for Windows can show the cards of a server you run, instead of running Relo itself. Choose **Connect to
a server** on the first screen, or **Use another Relo server…** in Settings.

- Type your server's full address in the field, for example `relo.example.com` or
  `http://192.168.1.5:8180`.
- Choose **Sign in**. It opens in your browser; finish there. Settings can sign in at any time.

Once signed in, the PC shows your server's cards. It does not install the relo command or set up your
agents: use **Add a computer** in the server's Dashboard for that.

## Leave Relo on this PC for a server

You can start on this PC and add a server when you need one:

- **Your iPhone, away from home.** Cards and questions on your Lock Screen need a server your phone can
  reach.
- **Several computers.** One server shows the work of every computer in one place.

First run your server with [Run the server](/docs/get-started/server). Then open **Settings → Relo →
Relo on this PC → Use another Relo server…** and sign in. Your agents report to that server after you
choose **Add a computer** in its Dashboard. Add your phone with [Add your iPhone](/docs/get-started/iphone);
more computers are covered in [Connect a computer](/docs/guides/servers).

## Uninstall

Open **Settings → Relo → Relo on this PC → Uninstall Relo from this PC…**. It removes the setup in your
agents' instructions, the background service and the `relo` command. It asks whether to delete your data
too. Then remove **Relo** under **Settings → Apps → Installed apps**.

Uninstalling the app without that step is safe too: the uninstaller stops Relo's background service and removes
its Task Scheduler task before it removes any file. Its **Delete the application data** box also deletes your
data in `%LOCALAPPDATA%\Relo\server`; left unticked, your data stays. The agents' instructions and the `relo`
command stay until you remove them with the Settings step above.
