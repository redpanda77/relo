---
title: Apps and webhooks
nav: Apps and webhooks
summary: Your own product sends alerts and asks you to approve a sign-up, a refund or a risky request, over HTTP, with signed answers.
---

## Why

Your app sometimes needs a person: approve a new sign-up, confirm a large refund, look at a failed
payment run. Relo gives it a way to reach you on your iPhone and get a tap back, without a shell or a
CLI on the app's servers. The app posts JSON to a **service** URL; you answer on the phone; the answer
comes back by a signed callback or by asking for it.

Two ways in:

| Your app has | Use | Good for |
| --- | --- | --- |
| nothing but HTTP | a **service**: an endpoint and a secret | alerts and questions from any stack |
| the CLI, or a login token | the same commands and API the CLI uses | sealed content, scripts' works, `relo listen` |

The second way is the CLI on a server; see [Scripts, cron and CI](/docs/guides/scripts) and
[Questions from code](/docs/guides/asking). The rest of this page is the service.

## Create a service

A service has a title (the sender on your phone), an optional image and default link, and a secret
(`hook_…`). It sends to your server's endpoint, `https://relo.example.com/hooks`, with the secret in a
header. The secret is a bearer credential: anyone holding it can send to you.

```sh
relo services create --title "Shop" --secret-file ./shop-relo-webhook
```

`--secret-file` writes the secret to a new file only you can read, instead of printing it, so it never
lands in a terminal log; the endpoint is printed. Move it into your app's secret store and delete the file. `relo services list`
shows your services without their secrets. A secret that leaked: `relo services rotate svc_… --secret-file PATH` gives
the service a new one and the old one stops working at once; `relo services revoke svc_…` ends the service. Every flag:
[account reference](/docs/reference/cli/account).

A service can do only what its scopes allow (all four unless you narrow them with `--scope`, repeatable, on
`relo services create` or `relo services edit`):

{{scopes service}}

A service cannot seal. When your account requires end-to-end encryption, a service sends only if you allow
readable content for it: `relo services edit svc_… --readable on`.

## Send an alert

Every notification names its project and topic, so it is filed with the rest of your work:

```sh
curl -sS https://relo.example.com/hooks \
  -H "Authorization: Bearer $RELO_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-run-2026-10-15" \
  -d '{"title":"Payout run failed","body":"3 of 41 payouts were rejected by the bank.",
       "context":{"project":"Shop","threadName":"Payouts"}}'
```

- The secret goes only in a header, `Authorization: Bearer hook_…` or `X-Relo-Webhook-Secret`, never in
  the URL, so proxies and access logs never record it. A request with the secret in the path is refused
  (`secret_in_url`); rotate a secret that has been in a URL.
- A request without both `context.project` and `context.threadName` is refused with
  `422 work_identity_required`.
- `Idempotency-Key` makes a retry return the first result instead of a second push. Use a stable key per
  event, never the secret.

## Ask a question

Add `response`. The body is the question, one line, readable from the Lock Screen:

```json
{
  "title": "Refund request",
  "body": "Refund order 8812 (240 EUR)?",
  "context": { "project": "Shop", "threadName": "Refunds" },
  "response": {
    "type": "approval",
    "expiresInSeconds": 7200,
    "correlationId": "order-8812",
    "callback": { "url": "https://shop.example.com/relo/answers", "token": "a-long-random-callback-token" }
  }
}
```

- `type` is `approval`, `yes_no` or `choice` (with 2 to 4 `options`, each `{"id","label"}`). Only an
  approval answered `approved` is permission; act on nothing else.
- Without a callback, read the answer with `GET /hooks/events/{eventId}`, using the `eventId` the post
  returned. Withdraw a question you no longer need with `POST /hooks/events/{eventId}/cancel`. Both send
  the secret in the header.

## Verify the answer

With `callback`, Relo POSTs the answer to your URL once you answer:

- the bearer token you chose, and two signatures over the raw body (`Relo-Signature`, and the Standard
  Webhooks `webhook-signature`), both keyed by that token;
- `Relo-Delivery-Id`, the same on every retry of one answer: process each id once;
- the phone's own signature over the answer, passed through untouched, so your app can trust the phone
  rather than the server.

Answer with any 2xx. Anything else is retried, ten attempts over about {{fact callback.giveUpSeconds}}; a 410 stops retries.
Expired or canceled questions never call back: silence past the expiry is a no. The payload and
verification code: [callbacks reference](/docs/reference/callbacks).

## Report a service's work

A long job inside your app (a migration, a batch run) can declare a work with a goal, plan and outcome,
like a script. A service uses `/hooks/works` (the secret in the header), with a `producerKey` in the start body naming the
job and an `Idempotency-Key` on every start; then the same update, heartbeat and finish routes as a
script. A service cannot seal, so its work text is readable by your server. Its card on the Lock Screen
follows the work like a script's: it starts with the work, advances with its steps and ends with its outcome.

```sh
curl -sS https://relo.example.com/hooks/works \
  -H "Authorization: Bearer $RELO_WEBHOOK_SECRET" -H "Content-Type: application/json" -H "Idempotency-Key: reindex-2026-10-15" \
  -d '{"producerKey":"search-reindex","goal":"Reindex the catalogue","plan":{"op":"set","steps":[{"label":"Export"},{"label":"Index"},{"label":"Swap"}]}}'
```

Every route, body and response: [HTTP API reference](/docs/reference/api).

## Keep the secret safe

- Store the secret only in a secret manager; never in source, chat, notifications, a URL or an
  idempotency key.
- Rotating a service replaces the secret and the old one stops working; update your secret store first.
- What a service sends belongs to your account only. Other accounts on the server never see it.
