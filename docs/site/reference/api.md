---
title: HTTP API
summary: Every route your scripts, apps and services call, with the fields each one takes.
---

The `relo` CLI is a client of this API, and anything that cannot run the CLI can call it directly:
an app that asks you to approve a sign-up, a service that reports its work, a job in a language of
its own. This page is generated from the server's OpenAPI document, which is in the repository at
[docs/api/openapi.json](https://github.com/redpanda77/relo/blob/main/docs/api/openapi.json).

Content you send over HTTP reaches the server readable: only the CLI seals it to your phones before it
leaves the computer. On an account that requires end-to-end encryption, use the CLI for anything
private. See [Encryption](/docs/concepts/encryption).

## Authentication

Every `/api` route takes `Authorization: Bearer <credential>`, where the credential is a login made with
`relo auth login` and approved by you in the browser ([Signing a client in](#signing-a-client-in)), or a CI
token you made for a pipeline ([CI tokens](#ci-tokens)). The
webhook routes take a service's secret instead ([Webhook services](#webhook-services)). Give each app its own login (a profile, or
`RELO_TOKEN` in a container) and narrow it with `relo auth login --scope SCOPE`. A login belongs to
one account and sees only that account.

{{scopes login}}

Errors are JSON with an `error` code. A refused login answers `401` or `403`; a rate-limited write
answers `429` with `retryAfterSeconds` ([Limits](/docs/reference/limits)). Every create takes an
`Idempotency-Key` header: a retry with the same key returns the first result.

## Producer works (scripts)

A script's or app's work: one goal, a plan, a status and an outcome, owned by the login plus a
producer key you choose. The path's `producerKey` is the base64url SHA-256 of `producer:` followed by
your readable key (43 characters); the CLI computes it for you. Start requires `Idempotency-Key`. A
lease ({{fact lease.minSeconds}} to {{fact lease.maxSeconds}}) says how long the work may stay silent; renew it with a heartbeat.

{{api /api/producers}}

## Session works

An agent session's own work. The CLI sends the session key it reads from the harness; these routes
are for the CLI and the MCP server, not for integrations, and refuse a producer's credential.

{{api /api/session}}

## Questions

Ask an approval, a yes/no or a choice of 2 to 4 options, then get the answer by waiting, by reading
it later, by the answer stream, or by a signed callback ([Answer callbacks](/docs/reference/callbacks)).
Only an approval answered `approved` is permission.

{{api /api/interactions}}

## Notifications

A one-off message about a finished outcome. Never a question, never progress.

{{api /api/notifications}}

## Cards

Cards of their own for apps and services that post over HTTP without a work. Scripts declare a work
instead, and its card follows.

{{api /api/live-activities}}

## Devices

The account's phones.

{{api /api/devices}}

## Your views

Your reads across the account. `/api/now` is the one place clients get derived state (what needs
you, what is fresh, what shows on the Lock Screen); the Dashboard and the apps only display it.

{{api /api/works /api/now /api/agent-sessions}}

## CI tokens

A login for a pipeline or container, made from your own signed-in login without a browser sign-in (`relo auth
token create`). It holds at most the scopes of the login that made it, always expires (after
{{fact credentials.ciTokenDefaultDays}} unless asked, at most {{fact credentials.ciTokenMaxDays}}), cannot make
another CI token, and is refused where only your own computer is meant (the encryption policy, hook
credentials). An account holds at most {{fact credentials.ciTokenMaxActive}}. The token is shown once; rotating
one gives it a new secret and the old one stops at once. Revoking ends it at once.

{{api /api/credentials}}

## Harness credentials

The hooks' presence-only credential. It has the single scope `presence:write` and works only on
`POST /api/agent-sessions/observed`; every other route refuses it. `relo setup --level guide`
mints one and `relo setup --level track` revokes it. A leaked one is rotated in place with
`POST /api/harness-credentials/{id}/rotate`.

{{api /api/harness-credentials}}

## Webhook services

A service is a sender with its own secret, for anything that speaks only HTTP. Create and rotate one with
`relo services create` or the Dashboard; each answers with its `endpoint` (`<origin>/hooks`) and its
`secret` (`hook_…`), shown once. Every webhook route takes the secret in a header, `Authorization: Bearer
hook_…` or `X-Relo-Webhook-Secret`, never in the URL: a path with a secret in it is refused
(`secret_in_url`). How to use it: [Apps and webhooks](/docs/guides/apps).

{{api /hooks}}

Managing services with a login:

{{api /api/services}}

## Signing a client in

The device authorization flow `relo auth login` uses, for any client: start with a client name, the
scopes it needs and a lifetime; show the owner the returned URL and code; poll `token` every
`intervalSeconds` until the owner approves it in the signed-in Dashboard. The credential is shown once.
Neither route takes a credential.

{{api /api/device-authorizations}}

Reading and signing out the login a request carries:

{{api /api/clients/self}}

## Readiness and administration

{{api /api/doctor}}

## Everything else

The routes not listed here belong to the Dashboard and the iPhone app (sign-in, the phone's
registration and keys, its inbox and answers, the Dashboard's settings and views) and are not a public
contract.
