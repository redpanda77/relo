# Choice questions: wire specification

Server, CLI, Dashboard and iOS build against this page; change it first if the contract changes.
For how an app uses choices alongside the rest of the API, see [INTEGRATING.md](INTEGRATING.md).

A question can offer 2–4 labeled options instead of Approve/Deny or Yes/No. There is no typed text.
The question is one line (≤ 120 characters); its explanation travels as `detail` (markdown, ≤ 4,000
characters), shown in Relo, never on the card.

## Options

```json
"options": [{ "id": "ship", "label": "Ship" }, { "id": "wait", "label": "Wait" }, { "id": "rollback", "label": "Roll back" }]
```

- 2–4 options. `id` matches `^[a-z0-9][a-z0-9_-]{0,31}$`; ids are unique.
- `label` is one line, 1–24 characters, unique ignoring case.
- A choice question takes no `primaryLabel`/`secondaryLabel`.

## Asking

| Endpoint | Body |
| --- | --- |
| `POST /api/live-activities/:id/wait` (card question, `relo ask`) | `{"type":"choice","prompt":"…","options":[…],"detail"?,"expiresInSeconds"}` |
| `POST /api/interactions` (both presentations) | `{"type":"choice","title","prompt","options":[…],"detail"?,…}` |
| `POST /hooks/:secret` (webhook service) | `"response":{"type":"choice","options":[…],"expiresInSeconds"}` |

Storage: `interaction_requests.kind = 'choice'`, `interaction_requests.options jsonb`.

## Which phones can answer

A phone declares `capabilities: ["choice_questions"]` in `POST /api/devices/register` and `PUT
/api/devices/:id` (stored in `devices.capabilities text[]`). Builds that do not send it cannot decode a
choice and never receive one:

- A choice question targets only phones with `choice_questions`. If none of the requested phones has
  it, the server answers `409 {"error":"choice_unsupported"}` and creates nothing.
- A choice question always targets phones explicitly (a broadcast is narrowed to the capable phones),
  and every phone-scoped read (inbox, history, current, pending, badge) shows a phone only its own
  targets, so an old build never receives one. New builds also skip any item whose kind they do not
  know instead of failing the page.

## Card (Live Activity)

Presentation behavior: `{"type":"choice","options":[{"id","label"}…]}`. ActivityKit content state
(flat, as today): `behaviorType: "choice"`, `choiceOptions: [{"id","label"}…]`, `primaryAction`/
`secondaryAction`/labels absent. 2 options: one row like approval. 3–4 options: one row of compact
buttons; the widget may drop the title line to fit. Tapping an option runs the existing response
intent with `action: "choose"` and `optionId`.

## Notification

`aps.category = "RELO_CHOICE"`; `relo.interactionType = "choice"`;
`relo.interactionOptions = [{"id","label"}…]`. The Notification Service Extension registers a
per-question category (`RELO_CHOICE.<interactionId>`, actions `RELO_OPTION.<optionId>` titled with the
labels, authentication required), keeps the newest 20 such categories alongside the static ones, and
sets the content's `categoryIdentifier` to it. Without the extension's rewrite the notification
shows no buttons and opens Relo.

## Answering

| From | Request |
| --- | --- |
| Notification action / in-app | `POST /api/notifications/:eventId/interactions` `{"kind":"choose","value":{"optionId":"ship"},"idempotencyKey","expectedInteractionId"?}` |
| Card button (ActivityKit intent) | `POST /api/live-activity-responses/:interactionId` `{"notificationId","deviceId","action":"choose","optionId":"ship","credential","idempotencyKey"}` |

An `optionId` that is not one of the question's options is `400 invalid_action`. The answer is stored
as state `replied` with `response: {"optionId":"ship","label":"Ship"}` (old CLIs read `replied` as
answered). Evidence kind `choose`. The card ends showing the chosen label.

## Reading the answer

- `GET /api/interactions/:id` and `/wait`: `{"type":"choice","state":"replied","options":[…],
  "response":{"optionId","label"},"action":"choose"}`.
- Inbox and current items carry `interaction.kind: "choice"` and `interaction.options`.
- Answer callbacks: `{"action":"choose","optionId","label",…}`.
- CLI: `relo ask "Which release?" --option Ship --option Wait --option "Roll back"` prints
  `{"ok":true,"id":"int_…","state":"chosen","option":"ship","label":"Ship"}` and exits 0. Option ids
  are derived from labels (lowercase, non-alphanumerics → `-`) unless given as `--option id=Label`.
