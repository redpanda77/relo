# ADR 0006: Operator-chosen origin, private or public

## Status

Accepted. Supersedes [ADR 0003](0003-private-network-first.md).

## Decision

Each installation chooses its own HTTPS origin (`RELO_APP_URL`); nothing in the server, Dashboard,
iPhone app or CLI assumes a particular host. A private tailnet origin and a public origin behind a
reverse proxy (for example Cloudflare Tunnel with Access) are both supported. The API stays bound to
loopback in either case, and public plaintext binding is still rejected.

## Consequences

- The iPhone app and CLI ask for the server at sign-in; a build-time origin only pre-fills it.
- Behind a proxy, `RELO_CLIENT_IP_HEADER` names the header carrying the real client address, believed
  only from a loopback or private peer, so per-client sign-in limits keep working.
- Every route answers whoever reaches the origin: request bodies are capped server-wide and HTTPS
  origins send HSTS. Browser pages should sit behind the proxy's own login where it has one.
- A TLS-terminating proxy sees credentials in transit and metadata, not end-to-end sealed content.
- APNs still needs only outbound access to Apple.
