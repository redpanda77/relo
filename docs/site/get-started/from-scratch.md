---
title: Start from nothing with your agent
nav: Start from nothing with your agent
summary: No server yet? Paste one line into Claude Code, Codex or any coding agent and it runs your Relo server, connects this computer and points you to the iPhone app, asking only what it must.
---

## For you

You have nothing set up yet, and you want a coding agent to do the work: run your own Relo server,
connect this computer, and get you ready for the iPhone app. Paste this into Claude Code, Codex,
OpenCode or any coding agent, on the computer that will run the server or on one that can reach it
over SSH:

```text
Read https://raw.githubusercontent.com/redpanda77/relo/main/docs/site/get-started/from-scratch.md and set up Relo for me.
```

The agent asks you two things (where the server runs and the address your devices will use), runs the
server, and hands you the browser for the one step that is yours: creating the owner account with your
own password. Then it connects this computer. It takes about half an hour, most of it the first build.

Server already running? Use [Set up with your agent](/docs/get-started/with-an-agent) instead. Prefer
to do it by hand? The same steps are in [Run the server](/docs/get-started/server).

## For the agent

You are a coding agent setting up Relo for the owner from nothing. Relo shows the work of their agents,
scripts and apps on their iPhone and asks them before risky steps. It runs on a server they own: one
Docker Compose stack (PostgreSQL, the API and a delivery worker). Do the steps below in order. Each one
starts with a check: skip what is already done, and do not move on until its check passes. Tell the
owner in a sentence what you are about to do before each step that changes a computer, and what you
found after it.

- **Ask only what you must:** where the server runs and its address (step 1), and later the one-time
  code from Connect a computer (step 7). Pick sensible defaults for the rest and say what you picked.
- **Never handle a password or a token.** The owner creates their account in the browser; you never
  fill that form, read their password or ask for it. Never print, copy or paste the contents of
  `deploy/secrets/` or the passwords in `deploy/.env`. Never put a token on a command line or in a
  file. If an SSH login or `sudo` asks for a password, stop and let the owner run that command.
- **The owner's accounts are theirs.** Do not create or change DNS records, Cloudflare, Tailscale or
  Apple accounts for them. Where the address needs one of those, tell the owner exactly what to do and
  wait.
- **The address in the examples** is `https://relo.example.com`: use the owner's address from step 1
  everywhere it appears.
- **Reference:** this page is in the public repository, `https://github.com/redpanda77/relo`. Every
  other docs page is there too, under `docs/site/` (for example
  `https://raw.githubusercontent.com/redpanda77/relo/main/docs/site/guides/origin.md`), and, once the
  server runs, at `/llms.txt` on the owner's server.

### 1. Ask the owner two things

Ask both in one message, with the recommended answers, and go on with those if the owner says so:

- **Where should the server run?** Recommended: on this computer, if it stays on and has Docker.
  Alternatives: another Linux or macOS host they reach with `ssh <host>` (a home server or a cloud
  machine). On another host, run every server command through that SSH alias; if `ssh <host> true`
  asks for a password, ask the owner to set up key login first or to run this prompt in an agent on
  that host.
- **What address will the iPhone and computers use?** One HTTPS origin reachable from all of them.
  Offer these, in this order, and recommend the first one that fits what they already have:

  ```text
  1  Tailscale Serve     Private: only devices on their tailnet. Needs Tailscale on the server and the phone.
  2  Cloudflare Tunnel   Public, no open port. Needs a domain on Cloudflare.
  3  Caddy               Public, on a host with a public IP and port 443. Needs a domain.
  4  Trial               http://localhost:8180, this computer only. The iPhone cannot reach it.
  ```

  For 2 and 3, ask for the hostname they want (`relo.example.com`). For a trial, say that the address
  must change before the iPhone can use Relo, and that changing it later means signing in again.

### 2. Check the server host

```sh
git --version
openssl version
docker version
docker compose version
```

All four must work, `docker version` must show a running server (the Docker daemon), and Compose must
be v2. If Docker is missing or stopped, tell the owner how to install or start it on their system
(Docker Desktop on macOS, Docker Engine on Linux) and wait: installing it needs their administrator
password. Also check that nothing else listens on port 8180 (`curl -s http://127.0.0.1:8180/health/ready`
should fail to connect, unless an earlier Relo is already running there: then check `docker compose ls`).

### 3. Get the code and the secrets

Skip the clone if a clone with `deploy/compose.yaml` already exists; use it.

```sh
git clone https://github.com/redpanda77/relo.git
cd relo
```

Then create the secrets, unless `deploy/.env` already exists (the script refuses to overwrite it, and
it should: those secrets protect an existing database):

```sh
./deploy/init-secrets.sh
```

This writes `deploy/.env` and `deploy/secrets/` with owner-only permissions: the database passwords,
the sign-in secret and a one-time owner token the server uses internally. Do not open or print them.

### 4. Set the address

Edit only these lines in `deploy/.env`, changing them in place (never print the whole file):

```dotenv
RELO_APP_URL=https://relo.example.com
RELO_BIND_ADDRESS=127.0.0.1
RELO_CLIENT_IP_HEADER=
RELO_CONTENT_RETENTION_HOURS=10
```

- `RELO_APP_URL` is the exact origin from step 1, with no path. For a trial, `http://localhost:8180`.
  For Tailscale Serve, it is the `https://…ts.net` origin that `tailscale serve status` prints (step 6);
  set it now if `tailscale status` already shows the host's name, or come back after step 6 and
  restart. It must be right before the owner account is created.
- `RELO_BIND_ADDRESS` stays `127.0.0.1`: the server is reached only through the address in front of it.
- `RELO_CLIENT_IP_HEADER` is `cf-connecting-ip` behind Cloudflare Tunnel, the header Caddy is set to
  overwrite behind Caddy, and empty for Tailscale Serve or a trial.
- Leave every other line as `init-secrets.sh` wrote it.

Check by printing only those keys:

```sh
grep -E '^(RELO_APP_URL|RELO_BIND_ADDRESS|RELO_CLIENT_IP_HEADER|RELO_CONTENT_RETENTION_HOURS)=' deploy/.env
```

### 5. Start the server

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8180/health/ready
```

The first build takes several minutes; run it in the background if your harness times out long
commands, and tell the owner it is building. The first start creates the database, applies migrations,
creates a restricted runtime role and starts the API and the worker. Retry the health check for up to
two minutes after the containers start. If it keeps failing, read:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 api worker
```

Fix what the logs name and start again. Push delivery stays off until the iPhone step; that is
expected.

### 6. Put the address in front of it

The server listens only on `127.0.0.1:8180`. Skip this for a trial.

- **Tailscale Serve**, on the server host, if `tailscale status` shows it signed in:

  ```sh
  tailscale serve --bg http://127.0.0.1:8180
  tailscale serve status
  ```

  Use Serve, never Funnel. Set `RELO_APP_URL` to the origin it prints if you have not yet, and restart
  with `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d`.
- **Cloudflare Tunnel:** if `cloudflared` is installed and already has a tunnel, show the owner the
  ingress rule to add (`hostname: relo.example.com`, `service: http://127.0.0.1:8180`). Creating the
  tunnel, its DNS record and any Cloudflare Access policy is the owner's to do in their Cloudflare
  account; point them to `docs/site/guides/origin.md` in the repository and wait.
- **Caddy:** show the owner the site block (`relo.example.com { reverse_proxy 127.0.0.1:8180 }`) and
  where it goes; the DNS record pointing the hostname at the host is theirs.

Then check the address from this computer:

```sh
curl --fail https://relo.example.com/health/ready
```

Ask the owner to open the address in their iPhone's browser: the Relo page must load over HTTPS with no
certificate warning. If the phone cannot reach it, the app will not either; fix the address before you
go on. A public address: tell the owner to read `docs/site/guides/hardening.md` and keep registration
Closed or Approval.

### 7. The owner creates their account

This step is the owner's. Tell them:

> Open https://relo.example.com in your browser. The first page says **Create the owner account**: enter
> your name, email and a password of at least eight characters. Then **Connect a computer** opens:
> choose the agent prompt for this computer and paste it here. (Later it is under **Account → Computers →
> Add a computer** in the Dashboard.)

Do not open the page, fill the form or ask for the password. Wait for the owner. Check it is done: the
address now shows the Relo landing page instead of the owner form.

### 8. Connect this computer

The prompt from Connect a computer reads `Read https://relo.example.com/install.md?code=rci_… and set
up Relo on this computer.` Fetch that page and follow it: it runs the one-line install with the code,
which installs the `relo` CLI, signs this computer in and sets up its agents the way the owner chose,
with nothing more to ask. A code works once, for 30 minutes; if it is rejected, ask the owner for a new
one.

Without a code, fetch `https://relo.example.com/install.md` (the owner's address) and follow it: it
installs the CLI and signs in through the browser. Its last step, `relo doctor`, waits for the iPhone
app; stop there and do step 9.

If the server runs on another host, connect the computer the owner works on, which is the one you run
on: the server host needs no CLI.

### 9. Point the owner to the iPhone app

The iPhone app is built by the owner in Xcode with their own Apple developer account, so this part is
theirs. Tell them what it takes and where the steps are:

- a Mac with Xcode, an iPhone with Developer Mode on, and an Apple Developer Program membership;
- an Apple push key (`.p8`) with its Key ID and Team ID, so the server can wake the phone;
- the steps: **Install the iPhone app** at `https://relo.example.com/docs/get-started/iphone`.

If this computer is that Mac and the owner asks, you can help with the steps that are files and
commands (the signing values in `apps/ios/Config/Signing.local.xcconfig`, the push settings in
`deploy/.env`), but the Apple account, the `.p8` key file and pressing Run in Xcode are theirs. Never
read or print the `.p8` key.

### 10. Finish

Once the phone is signed in, run `relo doctor` and follow its `next.run` until it prints `ready: true`;
the last step is `relo test`, a card on the phone asking "Can you see this card?" that the owner answers.
If the owner leaves the iPhone for later, finish without it and say what is left.

Tell the owner in a few lines: where the server runs, its address, the CLI version and the agents set
up. Tell them to restart their agent
sessions so they see the new instructions, and that each further computer needs only **Connect a
computer**. In the next session they can say:

> Use Relo to keep a live view of this task on my iPhone.
