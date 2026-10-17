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
| `POST /hooks` (webhook service; the secret in `Authorization: Bearer hook_…`, or `/hooks/:secret`) | `"response":{"type":"choice","options":[…],"expiresInSeconds"}` |

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

### Device capabilities

| Capability | Meaning |
|---|---|
| `choice_questions` | The build can show and answer a choice question; only such phones are targeted with one. |
| `owner_overview` | Reads the whole account's Now; never a delivery target. |

`owner_overview` is for an owner surface that is not a phone, such as the Mac's notch app (the iPhone
never declares it). Delivery stays strict: cards, questions and alerts still target only phones with
Live Activities authorized, so an overview device is never a target. Visibility for it is account-level,
like the Dashboard's: `/api/now`, `/api/inbox/current`, `/api/inbox/pending`, `/api/inbox/events` hints and
`GET /api/inbox/:id` skip the delivery-target filter, while sealed envelopes are still returned only when
the device is a recipient (computers seal cards and questions to it as a reader, never as an alerted
phone). It may answer a question on the copy the asking computer waits on (the copy a linked browser
answers); another copy is refused with `409 {"error":"not_asked_copy"}`. Its pending list shows that copy
only. It never approves another device, and a phone is never pending behind it. An overview build sees
every question kind, so it must decode them all (it declares `choice_questions` too).

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
