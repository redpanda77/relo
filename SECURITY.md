# Security policy

## Supported versions

Until Relo reaches `1.0`, only the latest tagged release receives security fixes. Upgrade before
reporting an issue that is already resolved in the current release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's **Security → Report
a vulnerability** flow to create a private GitHub security advisory. Include the affected version,
deployment shape, reproduction steps, and expected impact. Do not include production credentials,
APNs keys, webhook URLs, device tokens, or personal notification content.

You should receive an acknowledgement within seven days. A confirmed report will be coordinated
privately until a fix and disclosure plan are ready.

## Deployment responsibility

Relo is self-hosted. Operators are responsible for TLS, account access, server updates, Apple
credentials, and network exposure. See [the self-hosting guide](docs/SELF-HOSTING.md) for the
supported deployment boundary, and [the hardening guide](docs/HARDENING.md) for what protects a
publicly reachable server and the gaps that are still open.

## End-to-end encryption

Relo seals notifications, questions and Live Activity text on the sending computer for the owner's
trusted iPhones, and the phone signs every answer. The threat model and what the server can still
see are on the [Encryption page](https://github.com/redpanda77/relo/blob/main/docs/site/concepts/encryption.md); the exact protocol is in [docs/ENCRYPTION-PROTOCOL.md](docs/ENCRYPTION-PROTOCOL.md).
Reports about the protocol or its implementation follow the private advisory flow above.
