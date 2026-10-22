---
title: Get started
summary: Your own server, this computer and your iPhone, then your first live card, in about an hour.
---

## What you get

At the end of these five steps, an agent on your computer shows its work live on your iPhone's Lock
Screen, asks before risky steps, and tells you once when it is done. Every script and app you connect
later uses the same server and the same phone.

## The order

You set things up in the order Relo walks you through them:

1. **The server,** and the owner account you create on it in the browser.
2. **This computer,** right after: the Dashboard opens **Connect a computer** as soon as the account
   exists. One line in a terminal (or one message to your agent) installs the CLI, signs the computer in
   and sets up its agents. The first computer needs no approval from a phone.
3. **Your iPhone,** whenever you like: build the app, add your server, sign in and allow notifications.
4. **More computers,** one line each. A computer added after your iPhone is approved on the phone.

:::tip Prefer your agent?
Once the server runs, one message to your coding agent connects each computer: the CLI, the sign-in, and
every agent's skill and instructions. See [Set up with your agent](/docs/get-started/with-an-agent).
:::

:::tip No server yet?
One line to your coding agent does all of it: it runs the server, waits while you create the owner
account, connects this computer and points you to the iPhone app, asking only where the server runs and
its address. See [Start from nothing with your agent](/docs/get-started/from-scratch).
:::

## What you need

- **A server host:** Linux or macOS with Git, OpenSSL, Docker and Docker Compose v2. It can be the
  computer you work on, a home server or a cloud machine.
- **An address for it** that your iPhone and every computer can reach, over HTTPS. For a trial on one
  computer, `http://localhost:8180` is enough.
- **A browser** for the owner account and the Dashboard.
- **For the iPhone:** a Mac with Xcode, a physical iPhone with Developer Mode on, an Apple Developer
  Program membership to build and sign the app, and an Apple push key (`.p8`), with its Key ID and your
  Team ID, so the server can reach the phone.

Each computer needs nothing in advance: the one-line install brings Node.js 22 when the computer has no
recent one. You can run the server, the Dashboard and your computers without the Apple steps, but nothing
reaches the phone until they are done.

## The five steps

<ul class="docs-tiles">
<li><a href="/docs/get-started/server"><strong>1. Run the server</strong>Docker Compose, your address, secrets and the owner account. About 15 minutes.</a></li>
<li><a href="/docs/get-started/cli"><strong>2. Connect this computer</strong>The Dashboard's Connect a computer: one line or one agent prompt. About 5 minutes.</a></li>
<li><a href="/docs/get-started/iphone"><strong>3. Add your iPhone</strong>Build and sign in Xcode, add your server, sign in, allow notifications, turn on push. About 20 minutes.</a></li>
<li><a href="/docs/get-started/first-card"><strong>4. See your first card</strong>A test card, then a real work with a plan, a question and an outcome. About 5 minutes.</a></li>
<li><a href="/docs/get-started/agents"><strong>5. Tell your agents</strong>Restart them, check what setup wrote, then one sentence. About 5 minutes.</a></li>
</ul>

Each step ends with a check you can run. If one fails, [Troubleshooting](/docs/troubleshooting) starts
from its exact output.

## Adding another computer

The server and the phone are done once. For each further computer or server, open **Connect a computer**
again: in the Dashboard, **Account → Computers → Add a computer**; on your iPhone, **Settings → Devices →
Add a computer**; or `relo auth invite` on a computer that is already signed in. It gives one line that
installs, signs in and sets up, or a prompt for your agent:

```sh
curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…
```

A computer added once a phone exists can send to you at once, but its notifications stay locked on the
phone until you approve it: tap **Approve** on the request your iPhone shows (on **Now**, or in
**Settings → Devices**), or approve it from a browser you linked. When the iPhone made the code, it
approves the computer for you. See [Connect a computer](/docs/guides/servers).
