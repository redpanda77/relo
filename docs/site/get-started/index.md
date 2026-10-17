---
title: Get started
summary: Your own server, the iPhone app and your first live card, in about an hour.
---

## What you get

At the end of these five steps, an agent on your computer shows its work live on your iPhone's Lock
Screen, asks before risky steps, and tells you once when it is done. Every script and app you connect
later uses the same server and the same phone.

:::tip Server and phone already done?
Paste one line into your coding agent and it connects this computer for you: the CLI, the sign-in, and
every agent's skill and instructions. See [Set up with your agent](/docs/get-started/with-an-agent).
:::

## What you need

- **A server host:** Linux or macOS with Git, OpenSSL, Docker and Docker Compose v2. It can be the
  computer you work on, a home server or a cloud machine.
- **An address for it** that your iPhone and every computer can reach, over HTTPS. For a trial on one
  computer, `http://localhost:8180` is enough.
- **A Mac with Xcode,** a physical iPhone with Developer Mode on, and an Apple Developer Program
  membership to build and sign the app.
- **An Apple push key** (`.p8`), with its Key ID and your Team ID, so the server can reach the phone.
- **Node.js 22 or newer** on each computer that runs the `relo` CLI.

You can run the server and the Dashboard without the Apple steps, but nothing reaches the phone until
they are done.

## The five steps

<ul class="docs-tiles">
<li><a href="/docs/get-started/server"><strong>1. Run the server</strong>Docker Compose, your address, secrets and the owner account. About 15 minutes.</a></li>
<li><a href="/docs/get-started/iphone"><strong>2. Install the iPhone app</strong>Build and sign in Xcode, create your account, allow notifications, turn on push. About 20 minutes.</a></li>
<li><a href="/docs/get-started/cli"><strong>3. Connect this computer</strong>Connect a computer with one command or one agent prompt, check with relo doctor. About 5 minutes.</a></li>
<li><a href="/docs/get-started/first-card"><strong>4. See your first card</strong>A test card, then a real work with a plan, a question and an outcome. About 5 minutes.</a></li>
<li><a href="/docs/get-started/agents"><strong>5. Tell your agents</strong>One command for every agent on this computer, then one sentence. About 5 minutes.</a></li>
</ul>

Each step ends with a check you can run. If one fails, [Troubleshooting](/docs/troubleshooting) starts
from its exact output.

## Only connecting another computer?

The server and the phone are done once. For each further computer, **Connect a computer** (iPhone: Settings →
Add a computer; Dashboard: Settings → Computers → Add a computer; or `relo auth invite` on a signed-in
computer) gives one command that installs, signs in and sets up, or a prompt for your agent:

```sh
curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…
```
