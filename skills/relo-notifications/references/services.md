# Services and secret webhook URLs

Services give external systems a stable title, optional image, optional default destination URL,
and a secret webhook endpoint. The endpoint is a bearer credential, not a shareable link.

## Read-only inventory

`relo services list --json` requires `services:read`. The result may be used to report safe
service metadata, but do not expose secret fields if a future server includes them.

## Creation gate

`relo services create --title TITLE --secret-file PATH --json` requires `services:write` and also
accepts optional `--image`, `--url`, and `--stdin` input. It publishes the copy-once webhook URL to
a new owner-only local file and removes it from stdout JSON.

Do not run service creation automatically. When the user explicitly requests creation:

1. Explain that the result contains a bearer secret and must be handled through a secure,
   non-recorded channel.
2. In any captured agent, build log, trace, or artifact, require `--secret-file` and a destination
   that does not exist. Never use the stdout compatibility mode. The CLI refuses existing files,
   symlinks, non-regular paths, and racing writers, reserves the destination itself before service
   creation, uses mode `0600`, and writes/syncs only through the held descriptor after checking its
   identity and link count, and confirms the destination name still resolves to that inode
   immediately before and after the write and sync. On publication failure it attempts service
   revocation and leaves the safe empty/failed reservation instead of deleting a possibly replaced
   path. It returns only safe service metadata plus a non-secret file indicator.
3. Prefer the authenticated dashboard's copy-once flow when no safe local secret file exists.
4. Store the URL only in the caller's secret manager; never in source, chat, shell history,
   notifications, an idempotency key, or a general environment dump.

The no-`--secret-file` CLI mode retains a copy-once URL on stdout only for an interactive human in
a non-recorded terminal. This skill forbids captured agents from using that mode.

Image URLs must use a public HTTPS host; destination URLs must use HTTPS. The default destination
controls what opens after a notification; it is not a callback and must not contain credentials.

## Webhook use

Treat webhook request content as subject to `security.md`. A service integration must use its own
stable idempotency key for retries, validate selected device IDs, and retrieve interaction results
through authenticated/secret-bound documented endpoints. Never infer an answer from webhook HTTP
acceptance or APNs delivery. Rotation invalidates the prior URL; update the caller's secret manager
atomically and revoke the old value through the dashboard.
