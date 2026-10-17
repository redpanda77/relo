---
title: Answer callbacks
nav: Callbacks
summary: The signed POST Relo sends to your service when you answer a question, and how to handle it once.
---

A callback lets a service ask and move on: it does not hold a connection open, and Relo tells it the
answer the moment you tap. Register one with `relo ask --no-wait --callback-url URL
--callback-token-file PATH`, or with `callback: {url, token}` on `POST /api/interactions`
([HTTP API](/docs/reference/api#questions)). The token is a secret you choose, 16 to 512 characters
without spaces; Relo stores it encrypted and uses it both as the bearer token and as the signing key.

## The request

Once the question settles with an answer, Relo POSTs JSON to your URL:

```json
{"type":"notification.response","eventId":"ntf_…","interactionId":"int_…","correlationId":"order-81",
 "kind":"choice","status":"replied","action":"choose","optionId":"eu","label":"EU","text":null,
 "respondedAt":"2026-01-13T09:14:02.511Z","device":{"id":"dev_…","keyId":"…"},"signature":{…}}
```

| Field | What it is |
| --- | --- |
| `type` | always `notification.response` |
| `eventId`, `interactionId` | the question's notification and its id (`relo interaction get ID`) |
| `correlationId` | your own reference from `--correlation-id`, or `null` |
| `kind` | `approval`, `yes_no` or `choice` |
| `status` | `approved`, `denied`, `yes`, `no`, or `replied` for a chosen option |
| `action` | `approve`, `deny`, `yes`, `no` or `choose` |
| `optionId`, `label` | the chosen option, on a choice only |
| `text` | `null`: answers are taps, never typed text |
| `respondedAt` | when you answered, ISO 8601 |
| `device` | the phone (`dev_…`) or linked browser (`brw_…`) that answered, and the key it signed with |
| `signature` | its own signature over the answer, passed through untouched; `null` for a phone without published keys. A browser's signature counts only while a phone you trust linked it (14 days) |
| `answeredCopy` | only when another copy of the same question was answered (a second phone's copy, or the card's copy of a long question): `{ id, eventId }` of that copy. The signature covers these ids, not `interactionId`/`eventId`, and counts only bound (`signature.question`) to the context you sealed |

Only `kind: "approval"` with `status: "approved"` is permission. A question that expires or is
withdrawn never calls back: treat silence past the expiry as no, and reconcile with `relo
interaction get ID` (`GET /api/interactions/{interactionId}`) when your service restarts.

## Headers

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <your token>` |
| `Relo-Delivery-Id` | `cbk_…`, the same on every retry of one answer |
| `Relo-Signature` | `t=UNIX,v1=HEX`: HMAC-SHA256, keyed by your token, over `UNIX.BODY` |
| `webhook-id`, `webhook-timestamp`, `webhook-signature` | the same delivery signed the [Standard Webhooks](https://www.standardwebhooks.com) way: `v1,BASE64` over `ID.TIMESTAMP.BODY` |
| `User-Agent` | `Relo-Callbacks/1` |

Both signatures cover the same raw body; verify whichever your stack supports. For Standard
Webhooks, a token that starts with `whsec_` is keyed by its base64-decoded bytes, any other token by
its UTF-8 bytes.

## Verify it

1. Compare the bearer token with yours.
2. Recompute the signature over the raw body, before parsing it, and compare in constant time.
3. Reject a timestamp more than a few minutes old.
4. Process each `Relo-Delivery-Id` once: store it, and answer `2xx` to a repeat without acting again.

```js title="Node.js"
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(headers, rawBody, token) {
  const [t, v1] = headers["relo-signature"].split(",").map((part) => part.split("=")[1]);
  const expected = createHmac("sha256", token).update(`${t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

## Retries

Answer with any `2xx` within 10 seconds. Relo does not follow redirects. Anything else (another
status, a timeout, a network error) is retried on this schedule:

{{callback-schedule}}

Retries stop after the tenth attempt, {{fact callback.giveUpSeconds}} after the first, or at once when you answer `410
Gone`. Every retry carries the same `Relo-Delivery-Id` and `webhook-id` and a fresh timestamp and
signature.

## Where callbacks can go

A callback goes to a public `https://` address. A private address (where plain `http://` is also
accepted) works only when the server admin allows private callbacks for your account
([Accounts and administration](/docs/guides/accounts#limits-you-set)). The server's own loopback,
link-local and metadata addresses are always refused. Relo resolves the host once and connects to
that address, so a changing DNS answer cannot redirect it.
