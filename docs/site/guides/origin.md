---
title: Choose how phones reach your server
nav: Your server's address
summary: Give your iPhone, browser and computers one HTTPS address for your server, private or public.
---

Every device that uses Relo talks to one origin: your iPhone, the Dashboard in your browser, and
every computer and job that runs `relo`. Pick it once, before you create the owner account. Nothing
in Relo assumes a particular host; the iPhone app and the CLI ask for your address at sign-in.

## What the address needs

- **One HTTPS origin** with a certificate the iPhone trusts, such as `https://relo.example.com`. The
  iPhone app and the CLI accept plain `http` only for `localhost`, `*.local`, loopback, link-local
  and private (RFC 1918, `fc00::/7`) addresses: fine for a trial, not for daily use. The server
  refuses to start with plain `http` on a public address.
- **Reachable from every device**: the iPhone on mobile data too, if you want answers away from home,
  the browser, and every computer and CI runner that reports.
- **The API is reachable only from the server itself.** Compose publishes Relo on `127.0.0.1:8180`; a tunnel, proxy or
  overlay network in front of it terminates TLS and forwards to that port.

Relo needs no inbound port for push: the worker only connects out to Apple.

## Pick an option

| Option | Reachable from | Inbound port | Good for |
| --- | --- | --- | --- |
| [Tailscale Serve](#private-network-tailscale-serve) | only devices on your tailnet | none | one person, nothing on the public internet |
| [Cloudflare Tunnel](#public-cloudflare-tunnel) | anywhere | none | a home server or a host behind NAT, with an optional extra login |
| [Caddy on your domain](#public-caddy-or-another-reverse-proxy) | anywhere | 443 | a VPS with a public IP |

A private network keeps the server off the internet, so every device, including the phone, has to
be on it. A public address works anywhere, which also means Relo's own sign-in is all that stands in
front of it: read [Harden a public server](/docs/guides/hardening) before you open one.

## Private network: Tailscale Serve

With the host and every device on the same tailnet:

```sh title="On the server"
tailscale serve --bg http://127.0.0.1:8180
tailscale serve status
```

Set `RELO_APP_URL` to the exact `https://…` origin Serve prints. Use Serve, not Funnel: Funnel
publishes the address to the internet. WireGuard or another overlay with an HTTPS proxy works the
same way.

## Public: Cloudflare Tunnel

A tunnel makes only outbound connections, so the host opens no inbound port.

```yaml title="cloudflared config for a named tunnel"
ingress:
  - hostname: relo.example.com
    service: http://127.0.0.1:8180
  - service: http_status:404
```

Set `RELO_APP_URL=https://relo.example.com` and `RELO_CLIENT_IP_HEADER=cf-connecting-ip`. Leave Bot
Fight Mode off for the hostname and bypass the cache. Event streams send a keepalive every 15 seconds,
inside Cloudflare's idle timeout.

For an extra layer, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)
in front of the pages people open in a browser and let the app and CLI traffic through to Relo's own
authentication. Access matches the most specific path:

| Path | Access policy |
| --- | --- |
| `relo.example.com` | Allow the people who use this server |
| `relo.example.com/api`, `/hooks`, `/install.sh`, `/cli/relo-cli.tgz`, `/cli/version` | Bypass (iPhone, Lock Screen answers, CLI, webhooks, the install script and CLI download) |
| `relo.example.com/api/dashboard` | Allow |
| `relo.example.com/api/auth/sign-in`, `/api/auth/sign-up` | Allow |

The iPhone signs in through the same browser pages, so the Access login appears there once.

:::privacy What the tunnel sees
Cloudflare terminates TLS. Sealed content stays opaque to it, but credentials in transit and
metadata (times, sizes, which routes) do not. See [Encryption](/docs/concepts/encryption).
:::

## Public: Caddy or another reverse proxy

```caddyfile title="Caddyfile"
relo.example.com {
    reverse_proxy 127.0.0.1:8180
}
```

Set `RELO_APP_URL=https://relo.example.com`. Caddy obtains the certificate itself. Caddy adds no
client-address header by default: set one that the proxy overwrites with the client's address, and
name it in `RELO_CLIENT_IP_HEADER`; with a CDN in front, use the CDN's header. nginx and Traefik work
the same way: proxy to the loopback listener, and keep event streams open (no response buffering, a
read timeout above 15 seconds).

## Configure the server

In `deploy/.env`:

```dotenv
RELO_APP_URL=https://relo.example.com
RELO_BIND_ADDRESS=127.0.0.1
RELO_CLIENT_IP_HEADER=cf-connecting-ip
```

- `RELO_APP_URL` is the exact origin, with no path. Set it before you create the owner account.
- `RELO_BIND_ADDRESS` stays `127.0.0.1`.
- `RELO_CLIENT_IP_HEADER` names a header your proxy **overwrites** with the client's address, never
  one a client can append to such as `x-forwarded-for`. Without it, behind a proxy, every request
  looks like it comes from the proxy and the per-client sign-in limits become one shared limit. Relo
  believes the header only from a loopback or private peer.

Then restart:

```sh title="On the server"
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

## Check it

From the phone's browser, open your address: the Relo page loads over HTTPS with no certificate
warning. If the browser cannot reach it, the app cannot either. On each computer, `relo auth login
--api-url https://relo.example.com` signs in against it and `relo doctor` checks the rest.

## Change it later

Change `RELO_APP_URL`, restart the API and worker, then sign in again on each phone and computer.
