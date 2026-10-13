# ADR 0003: Private-network-first access

## Status

Superseded by [ADR 0006](0006-operator-chosen-origin.md).

## Decision

Relo is designed to run on a private network. Local development may use private-address HTTP;
normal remote use requires HTTPS, with Tailscale/private HTTPS as the recommended path.

## Consequences

- The server does not require a public inbound endpoint for ordinary product operation.
- APNs still requires outbound connectivity to Apple.
- Setup and doctor checks must explain whether the configured origin is reachable by the iPhone.
- Public plaintext binding is rejected.
