# Scripts, apps, services and secret webhook URLs

## Scripts and apps as producers

A script, CI job or app that is not an agent session shows its work with the same `relo work` verbs,
named by a producer key instead of a session:

```bash
export RELO_SESSION=deploy-bot          # or pass --producer deploy-bot on every command
relo work start --producer deploy-bot --goal "Deploy 2.4" --plan "Build,Migrate,Ship" --idempotency-key "$CI_PIPELINE_ID-deploy"
relo work update --producer deploy-bot --next-step
relo work heartbeat --producer deploy-bot --lease 15m
relo ask "Deploy 2.4 to production?" --approval --expires-in 30m --timeout 30m --idempotency-key "$CI_PIPELINE_ID-ask"
relo work finish --producer deploy-bot --outcome "2.4 is live"
relo state --producer deploy-bot
```

- **Producer key**: `--producer KEY` or `RELO_SESSION=KEY`, 1-100 characters from letters, digits,
  `.`, `_`, `:`, `-`. The owner sees it as the work's label ("deploy-bot"). A script without one is
  refused with the exact `relo work start --producer …` command. Two jobs with the same key share one
  open work (a second start continues it unless `--new`).
- **Idempotency**: `--idempotency-key` is required on `work start` and `ask` when stdin is not a TTY,
  so a retry never makes a second work or question; it is generated at a terminal.
- **Heartbeat**: `relo work heartbeat [--lease 15m]` keeps the card moving without updates for the
  lease (60s to 1h, default 15 min). The echo says until when: renew before then. Agents cannot
  heartbeat; a session shows it is alive through its own updates.
- **Long waits**: `--expires-in 30m` keeps the question open that long and `--timeout 30m` blocks
  for it (at most the question's lifetime; default 5 minutes). Exit `0` approved, `5` denied, `8`
  expired or canceled, `4` still open when the wait ended (`relo interaction wait ID` resumes it),
  `1` server, `6` network. Only exit `0` with state `approved` is permission. An agent waits about
  100s per command and resumes with `relo interaction wait ID`.
- Output is one JSON line when piped:
  `{"ok":true,"disposition":"started","work":{"id":"wrk_…","lifecycle":"open","version":1,"step":"1/3"},"lease":null}`.
- `relo listen` with a producer key reads only that producer's answers.

## Services and secret webhook URLs

Services give external systems a stable title, optional image, optional default destination URL,
and a secret webhook endpoint. The endpoint is a bearer credential, not a shareable link.

### Read-only inventory

`relo services list --json` requires `services:read`. The result may be used to report safe
service metadata, but do not expose secret fields if a future server includes them.

### Creation gate

`relo services create --secret-file PATH --json` (named with its title option; `relo schema services`
lists it) requires `services:write` and also accepts optional `--image`, `--url`, and `--stdin` input. It publishes the copy-once webhook URL to
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

### Webhook use

Every new webhook notification and Live Activity start must name its project and topic, like every
other producer: send `context.project` and `context.threadName` (or an `origin` descriptor). The
service is the source. A request without both returns `422 work_identity_required`. Updates and ends
keep the identity stored at creation.

```json
{ "title": "Backup failed", "body": "Nightly dump did not complete.",
  "context": { "project": "Recovery Collector", "threadName": "Operational status" } }
```

A webhook question can call your server back instead of being polled: add
`"callback": {"url": "https://...", "token": "<16-512 chars>"}` inside `response`. Relo POSTs the
answer with `Authorization: Bearer <token>`, retrying after 30s, 2m, 10m and 1h; only real answers
call back. `GET /hooks/<secret>/events/:eventId` reports `response.callback.state`.

Treat webhook request content as subject to `security.md`. A service integration must use its own
stable idempotency key for retries, validate selected device IDs, and retrieve interaction results
through authenticated/secret-bound documented endpoints. Never infer an answer from webhook HTTP
acceptance or APNs delivery. Rotation invalidates the prior URL; update the caller's secret manager
atomically and revoke the old value through the dashboard.

### Wiring an app to the answers

An app that asks through the CLI gets answers by blocking (`relo ask`), by id later
(`relo interaction wait ID`), by a signed callback, or by `relo listen`; see
[cli.md](cli.md#questions). Each app uses its own login (`relo auth login --profile NAME`).
