---
title: Run the server
nav: 1. Run the server
summary: Your own Relo server, running in Docker behind an address your iPhone and computers can reach.
---

## What you get

One server for everything you connect: it keeps the clock, combines every source into one view,
delivers to your phone and checks every credential. It is yours, and it never reads your content. It
runs as one Docker Compose stack: PostgreSQL, the API and a delivery worker.

## Set it up

<ol class="docs-steps">
<li>

**Clone the repository** on the server host.

```sh title="On the server"
git clone https://github.com/redpanda77/relo.git
cd relo
```

</li>
<li>

**Choose the address your iPhone will use.** The server listens only on `127.0.0.1:8180`. Pick one
origin for the browser, the iPhone and every computer that runs the CLI. It must be:

- reachable from all of them, and
- HTTPS, served by something in front of Relo so the API stays on loopback. The iPhone app accepts
  plain `http` only for a local or private address, which suits a trial.

Common choices: a tunnel or reverse proxy to `http://127.0.0.1:8180` (Cloudflare Tunnel, Caddy, nginx,
Traefik) on your own domain such as `https://relo.example.com`, a private overlay network such as
Tailscale Serve, or `http://localhost:8180` for a trial on this computer only. Examples for each:
[Choose your address](/docs/guides/origin).

</li>
<li>

**Create the secrets and set the address.**

```sh title="On the server"
./deploy/init-secrets.sh
```

This writes `deploy/.env` and `deploy/secrets/` with owner-only permissions: the database passwords,
the sign-in secret and a one-time owner token the server uses internally (never paste it anywhere).
Then open `deploy/.env` and set:

```dotenv
RELO_APP_URL=https://relo.example.com
RELO_BIND_ADDRESS=127.0.0.1
# behind a proxy: the header it overwrites with the client address, e.g. cf-connecting-ip
RELO_CLIENT_IP_HEADER=
# delete ended content after this many hours (10 is the default promise; empty keeps it)
RELO_CONTENT_RETENTION_HOURS=10
```

Set `RELO_APP_URL` before you create the owner account. Without `RELO_CLIENT_IP_HEADER` behind a proxy,
every request looks like it comes from the proxy and sign-in limits become one shared limit.

</li>
<li>

**Start the server.**

```sh title="On the server"
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8180/health/ready
```

The first start creates the database, applies migrations, creates a restricted runtime role and starts
the API and the worker. Push delivery stays off until [step 2](/docs/get-started/iphone). If something
fails:

```sh title="On the server"
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 api worker
```

</li>
<li>

**Create the owner account.** Open your `RELO_APP_URL` in a browser. The first page says **Create the
owner account**: enter your name, email (`you@example.com`) and a password of at least eight
characters. This account owns the server and is its admin. Other people get separate, private
accounts: [Accounts](/docs/guides/accounts).

After that, the address shows the Relo landing page, and you sign in at `/sign-in`.

</li>
</ol>

## Check it

```sh title="On the server"
curl --fail http://127.0.0.1:8180/health/ready
```

From your phone's browser, open `RELO_APP_URL`: you should see the Relo page over HTTPS with no
certificate warning. If the phone cannot reach it, the app will not either. Fix the address before
you continue.

:::tip Before a public address
Keep registration **Closed** or **Approval** (Account → Server accounts), and read
[Hardening your server](/docs/guides/hardening).
:::
