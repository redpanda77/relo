# ADR 0010: Shared server modules

Status: accepted and implemented, 15 October 2026. Applies [ADR 0008](0008-relo-design-framework.md) (one module
per producer type; shared code only for identical primitives) and [ADR 0009](0009-cli-structure.md) (facts once;
data in tables) to the server, and to what the server, the CLI and the docs share.

## Context

Writing the docs site showed the same few problems behind many gaps:
- Credentials were minted, checked and revoked in six places.
- Scopes were listed three times and checked as loose strings.
- Rate limits were a path regex with copies; work routes were outside it by omission.
- The webhook routes each resolved their service their own way, and one let a disabled account's service read.
- The card projector took only a login.
- Product numbers were typed in server modules, help, the skill and the docs.
- Three origin classifiers disagreed.
- The "may this be stored readable" rule was written out in seven routes and missing from services.
A fix for any one gap would have added another copy.

## Decision: one module per concern

| Module | Owns | Never |
| --- | --- | --- |
| `apps/server/src/credentials/` | Minting, authenticating, rotating, revoking, listing and recording last use of every credential kind (login, CI token, phone, hooks, service); the only token digests | A route writing a token, secret, revocation or last-use column, or hashing a token |
| `packages/contracts/src/scopes.ts` | Every scope, what it allows and which credential kinds may hold it; the CLI's generated copy; the docs' `{{scopes}}` | A scope string that is not in the registry (checks are typed by `Scope`) |
| `apps/server/src/webhooks/` | The service producer: sign-in (resolves the service once, enforces `WEBHOOK_ROUTE_SCOPES`), notices, cards, works, management, schemas | A route reading the service's secret, or a `/hooks` route without a scope |
| `apps/server/src/request-policy.ts` | Which writes count, in which family, against which limits, by the matched route | A rate limit anywhere else; a write route neither counted nor listed outside with a reason |
| `apps/server/src/works/card-actor.ts` | What projecting a work onto its card needs from its producer (who it runs as, its presentation policy, its identity namespace) | A card projector for one producer kind only |
| `packages/contracts/src/facts.ts` | Every number Relo promises; the CLI's generated copy; `{{fact id}}` in the docs and markers in the skill | A product number typed in code, help, the docs or the skill |
| `apps/server/src/content-policy.ts` | Whether content may be stored readable (`refuseReadable`), the retention window the worker runs with, for every producer type, doctor and the Dashboard | A readable-content decision made in a route |
| `packages/contracts/src/origin.ts` | Which hosts are private, for the server's plain-HTTP rule, the CLI's strict default and its public-only URLs (generated into the CLI) | Another classifier |
| `scripts/release/head-gates.sh` | Gating an archive of HEAD, the release lock, versions that only move forward | A release from a working tree |

## What code review rejects

- A credential column written, or a token hashed, outside `credentials/`.
- A scope literal outside the registry, or a scope list kept in a module.
- A rate limit outside the request policy table.
- A card projected for one producer kind only.
- A product number outside the facts module.
- A readable-content decision outside the content policy.
- An origin check outside the shared rule.
- A generated file edited by hand.

## How it is enforced

| Test | Keeps |
| --- | --- |
| `credentials-reachability.test.ts` | credential writes and digests in `credentials/`, the resolved service in `webhooks/` |
| `scope-registry.test.ts` | every scope literal known, no module with its own list, column defaults equal to the registry |
| `webhooks/auth.test.ts` | a scope for every `/hooks` route, sign-in the same on every route |
| `request-policy.test.ts` | every write route counted or listed outside |
| `content-policy.test.ts` | no route deciding on readable content, every producer refused the same way |
| `packages/contracts/test/generated.test.ts` | the CLI's generated facts, scopes and origin rule fresh |
| `packages/cli/test/no-typed-facts.test.mjs` | no product number typed into the CLI |
| the docs builder's `checkTypedFacts` | no product number typed into the docs |
| the skill validator | the skill's generated facts fresh |

## Consequences

Adding a credential kind, a scope, a webhook route, a write route or a promised number is one entry in one
table, and the tests name what is missing. Service works got cards, and service scopes and readable content
became settings, because the modules existed rather than as special cases.
