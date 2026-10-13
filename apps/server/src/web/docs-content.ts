import { escapeHtml } from "./http.js";
type DocumentationSection = { title: string; body: string; links?: Array<{ label: string; href: string }> };

const sections: DocumentationSection[] = [
  {
    title: "Send notifications",
    body: "Create a named service, copy its secret webhook URL without rendering it, and POST a JSON body. Ordinary notifications support a public HTTPS image, a validated HTTPS destination, explicit device targeting, and approval, yes/no, or text responses.",
    links: [{ label: "Manage services", href: "/dashboard/connections" }, { label: "Review history", href: "/dashboard/inbox/notifications" }],
  },
  {
    title: "Authorize agents and the CLI",
    body: "A client requests narrowly scoped access. An owner must explicitly approve it; every other outcome denies access. Credentials are shown once and can be revoked from the dashboard.",
    links: [{ label: "Review approvals", href: "/dashboard" }, { label: "Manage clients", href: "/dashboard/connections" }],
  },
  {
    title: "Coordinate Live Activities",
    body: "Launch uniquely identified test runs, update or end the selected ID, and observe exact-event phone receipts and canonical responses. Presets are shortcuts into one compositional builder, not separate pages or schemas.",
    links: [{ label: "Open the Test Lab", href: "/dashboard/testing" }],
  },
  {
    title: "Operate safely",
    body: "Use delivery history for target-level APNs status and keep notification content concise enough for phone surfaces.",
    links: [{ label: "Inspect delivery", href: "/dashboard" }, { label: "Inspect phones", href: "/dashboard/connections" }],
  },
];

export function dashboardDocumentationHtml(): string {
  return `<section class="card"><h2>Documentation</h2><p class="muted">Relo is a coordinated notification workflow: delivery, persistent history, phone interaction, and result retrieval are one lifecycle.</p>${sections.map((section) => `<section class="panel"><h3>${escapeHtml(section.title)}</h3><p>${escapeHtml(section.body)}</p><div class="actions">${(section.links ?? []).map((link) => `<a class="button secondary" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}</div></section>`).join("")}<p class="callout">Machine-readable guidance is available at <a href="/docs.md">/docs.md</a>, <a href="/agents.md">/agents.md</a>, and <a href="/llms.txt">/llms.txt</a>.</p></section>`;
}

const machineProtocolMarkdown = `## Authentication

- Scoped API and CLI routes use \`Authorization: Bearer <access-token>\`. Request only the scopes required by the operation. Tokens are returned once and must never be placed in notification content.
- Service webhooks use the unguessable \`/hooks/<service-secret>\` path returned once at service creation or rotation. The secret is the credential.
- Device routes use a device bearer credential issued by registration. Live Activity response credentials are device-bound capabilities projected into a command and expire with its interaction.
- Dashboard routes use the owner browser session. A phone permission request is authorized only by an explicit approval; deny, no, timeout, cancellation, missing input, and errors do not authorize it.

## Owner account and dashboard session

Relo is single-owner software. The first browser account claims the bootstrapped owner; later sign-up attempts return \`account_already_configured\`. Use the dashboard sign-up/sign-in forms instead of scripting browser-session cookies. Browser mutations require both the authenticated owner session and an exact same-origin \`Origin\` header.

- \`POST /api/auth/sign-up/email\`: first-run email/password account claim.
- \`POST /api/auth/sign-in/email\`: sign in; Relo requires \`rememberMe: true\`.
- \`GET /api/auth/get-session\`: return the current session or \`reauthentication_required\`.
- \`POST /api/auth/change-password\` and \`POST /api/auth/sign-out\`: Better Auth owner-session operations used by the dashboard.
- \`POST /api/account/delete\`: delete active account/domain data after current-password verification and exact \`DELETE\` confirmation. A committed HTTP 200 returns \`{ "ok": true }\`; encrypted backups may retain older data until configured rotation.

Owner-only dashboard mutations live under \`/api/dashboard/*\`. They create/edit/rotate/revoke services, revoke devices or client credentials, and start/update/wait/end test Live Activities. Service webhook URLs and rotated secrets can be copied once but are never rendered; store them immediately and never place them in notifications or logs.

## CLI authorization and credential lifecycle

The CLI uses an OAuth device-style flow without sharing the owner password:

1. \`POST /api/device-authorizations/start\` with \`clientName\`, the requested \`scopes\`, and \`expiresInSeconds\`. The response contains a short-lived \`deviceCode\`, human \`userCode\`, verification URL, expiry, and polling interval.
2. The owner signs in at \`GET /cli/authorize?code=...\`, verifies the client/scopes/expiry, and explicitly authorizes or denies. Signing in alone never approves access.
3. Poll \`POST /api/device-authorizations/token\` with the \`deviceCode\`. Respect \`authorization_pending\`, \`slow_down\`, \`access_denied\`, \`expired_token\`, and \`Retry-After\`. A successful response exposes \`accessToken\` once plus credential metadata.
4. Inspect the current machine credential with \`GET /api/clients/self\`; revoke it idempotently with \`DELETE /api/clients/self\`.

Available client scopes are \`notifications:send\`, \`interactions:create\`, \`interactions:read\`, \`activities:write\`, \`activities:read\`, \`devices:read\`, \`services:read\`, and \`services:write\`. Request the smallest set needed.

## Device registration and synchronization

The signed-in iOS app registers or rotates its device credential with \`POST /api/devices/register\`. Supply an \`Idempotency-Key\` and the stable/installation identifiers, app and OS metadata, APNs environment/token, notification and Live Activity authorization states, and optional push-to-start token. The response contains account metadata, public device metadata, and a device \`accessToken\` shown once. Replaying the same key and body returns the same derived credential; changing the body returns \`idempotency_conflict\`.

On the iPhone, open Relo and tap Sign in. It opens this server's sign-in page in the browser, and you approve it there. The app then registers with \`POST /api/devices/register\`.

Device credentials use these routes:

- \`GET /api/devices/self\`: confirm the bound account, device identity, registration state, and credential version.
- \`PUT /api/devices/:deviceId\`: heartbeat and update the calling device's app/OS metadata, authorization state, APNs token, and push-to-start token. A device cannot update another device.
- \`PUT /api/devices/self/live-activities/:activityId/token\`: register or replace the calling device's native Live Activity update token for an active targeted activity.
- \`GET /api/inbox/current\` and \`GET /api/inbox/pending\`: current summaries and independently paged valid decisions. Use canonical counts and original deadlines; do not infer action validity from history.
- \`GET /api/inbox/events\`: scoped foreground change hints. Reconcile current state immediately after reconnect; hints are not a history replay cursor.
- \`GET /api/inbox/snapshot\`: replace the local history window with the newest 250 summaries. Rows, whole-history unread counts, total, and server time share one database snapshot. Repeat this bounded repair to discover late commits. Full message bodies and executable activity commands are absent; retrieve an exact original notification through \`GET /api/inbox/:notificationId\` when opened.
- \`POST /api/inbox/read-items\`: mark 1–250 exact captured notification IDs read. Duplicate IDs coalesce; each result is \`read\`, \`already_read\`, or \`not_found\` under the calling device visibility. Retry the same IDs after reconnect; never expand a saved read intention to newly arrived notifications. Global unread totals accompany the acknowledgments.
- \`GET /api/inbox?after=<cursor>&limit=<1-100>\` and \`GET /api/inbox/history\`: retained for the installed predecessor client during coordinated iOS rollout. Timestamp deltas are not complete repair and must not determine current relevance or global actionable counts.
- \`POST /api/notifications/:notificationId/interactions\`: report received/opened state or submit approval, deny, yes, no, or text-answer responses with a device credential.
- \`POST /api/live-activity-responses/:interactionId\`: submit an App Intent approval/yes-no response with the command's device-bound, expiring capability.
- \`DELETE /api/devices/:deviceId\`: revoke the calling device, its credentials, delivery jobs, and push tokens.

A scoped client can list active devices with \`GET /api/devices\` (\`devices:read\`). Device/APNs and ActivityKit tokens are transport credentials: they are encrypted at rest and are never returned by list, self, dashboard, or history responses.

## Ordinary notification API

\`POST /api/notifications\` requires \`notifications:send\`. Supply \`Idempotency-Key\` with 1–200 characters when replay identity matters.

\`\`\`json
{
  "title": "Build complete",
  "body": "Candidate 42 passed verification",
  "sourceName": "Codex",
  "imageUrl": "https://images.example.com/result.png",
  "destinationUrl": "https://example.com/builds/42",
  "deviceIds": ["dev_opaque"],
  "context": { "computer": "Mac", "account": "work", "project": "Relo", "threadName": "Releases", "taskTitle": "Verify release" }
}
\`\`\`

The public image URL must not resolve syntactically to localhost, a private/reserved IP, a single-label host, or a \`.local\`, \`.internal\`, \`.home\`, or \`.lan\` name. Destination URLs are at most 2048 characters and may be an \`https://\` page or universal link, an app's own scheme (\`your-app://incidents/42\`), or a Shortcuts URL (\`shortcuts://run-shortcut?name=Deploy%20Follow-up&input=text&text=done\`). \`http:\`, \`javascript:\`, \`data:\`, \`file:\`, \`blob:\` and \`about:\` are rejected. The phone opens a destination only when the owner taps it; receiving a push never opens anything. Private delivery masks title/body and omits context, conversation, avatar, image, and destination metadata before APNs.

Created response (HTTP 201; an exact replay returns HTTP 200 with \`replayed: true\`):

\`\`\`json
{
  "eventId": "ntf_opaque",
  "createdAt": "2026-08-07T00:00:00.000Z",
  "delivery": { "eligibleDevices": 1, "durableCommands": 1, "apnsJobs": 1 },
  "queued": 1,
  "replayed": false
}
\`\`\`

## Interaction API

\`POST /api/interactions\` requires \`interactions:create\`. Ordinary presentation supports \`approval\`, \`yes_no\`, and \`text\`; Live Activity presentation supports approval and yes/no only.

\`\`\`json
{
  "title": "Release decision",
  "prompt": "Ship the verified candidate?",
  "type": "approval",
  "presentation": "live_activity",
  "style": "shell",
  "primaryLabel": "Ship",
  "secondaryLabel": "Stop",
  "expiresInSeconds": 600,
  "deviceIds": ["dev_first", "dev_second"],
  "privacy": "standard",
  "correlationId": "release-42",
  "callback": { "url": "https://ci.example.com/relo-answer", "token": "a-private-token-of-16-to-512-chars" }
}
\`\`\`

\`privacy: "private"\` (Live Activity presentation only) shows "Private activity" on the phone; the title, prompt and status are never stored or sent.

**Answer callbacks.** With \`callback\`, Relo POSTs the answer to your public HTTPS URL with \`Authorization: Bearer <token>\`, \`Content-Type: application/json\` and a \`Relo-Callbacks/1\` user agent. Redirects are not followed and each attempt times out after 10 seconds. A non-2xx response is retried after 30 seconds, 2 minutes, 10 minutes and 1 hour, then marked failed: treat delivery as at-least-once and key your handler on \`interactionId\`. Only an actual answer calls back; expired or canceled questions never do. The token is stored encrypted and never returned; \`interaction.callback\` reports \`state\`, \`attempts\`, \`lastStatus\`, \`lastError\` and \`deliveredAt\`.

\`\`\`json
{
  "type": "notification.response",
  "eventId": "ntf_opaque",
  "interactionId": "int_opaque",
  "correlationId": "release-42",
  "kind": "approval",
  "status": "approved",
  "action": "approve",
  "text": null,
  "respondedAt": "2026-08-07T00:03:00.000Z"
}
\`\`\`

\`kind\` is \`approval\`, \`yes_no\`, or \`reply\`; for a reply, \`text\` holds the answer.

All targeted devices receive device-bound commands for one canonical interaction. The first valid response wins; later responses return terminal state without changing the result.

Interactive style guidance:

- \`approval\`: an explicit allow/deny permission gate.
- \`shell\`: a terminal-flavored allow/reject gate for agent work.
- \`verdict\`: a balanced yes/no product or release decision.
- \`signal\`: a high-attention respond/dismiss operator checkpoint.

\`GET /api/interactions/:interactionId\` and \`GET /api/interactions/:interactionId/wait?timeoutSeconds=60\` require \`interactions:read\`. \`POST /api/interactions/:interactionId/cancel\` requires \`interactions:create\`.

\`\`\`json
{
  "interaction": {
    "id": "int_opaque",
    "eventId": "ntf_opaque",
    "type": "approval",
    "prompt": "Ship the verified candidate?",
    "state": "approved",
    "action": "approve",
    "response": { "action": "approve" },
    "respondingDevice": { "id": "dev_opaque", "name": "Developer’s iPhone" },
    "expiresAt": "2026-08-07T00:10:00.000Z",
    "respondedAt": "2026-08-07T00:03:00.000Z"
  }
}
\`\`\`

Terminal states are \`approved\`, \`denied\`, \`yes\`, \`no\`, \`replied\`, \`expired\`, and \`canceled\` as applicable.

## Service webhook and result retrieval

Create services with \`POST /api/services\` (\`services:write\`) and list them with \`GET /api/services\` (\`services:read\`). Creation and rotation return \`webhookUrl\` once.

\`POST /hooks/<service-secret>\` accepts:

\`\`\`json
{
  "title": "Approval needed",
  "body": "Continue deployment?",
  "imageUrl": "https://images.example.com/deploy.png",
  "url": "https://example.com/deployments/42",
  "deviceIds": ["dev_opaque"],
  "context": { "project": "Deployments", "threadName": "Release 42" },
  "response": { "type": "approval", "expiresInSeconds": 600, "correlationId": "deploy-42",
    "callback": { "url": "https://ci.example.com/relo-answer", "token": "a-private-token-of-16-to-512-chars" } }
}
\`\`\`

Every new notification, decision, and Live Activity names its project and topic: send \`context.project\` and \`context.threadName\`, or an \`origin\` descriptor. The service, credential, or CLI source is the source. Missing either returns \`422 work_identity_required\`; updates and ends keep the identity stored at creation.

Read the canonical result at \`GET /hooks/<service-secret>/events/:eventId\`. Cancel a pending result with \`POST /hooks/<service-secret>/events/:eventId/cancel\`.

The immediate webhook response reports eligible devices, durable commands, and queued APNs jobs; it never calls queued work delivered. The later result includes target-job counts. \`acceptedByProvider\` means Apple accepted the request, not that an iPhone displayed it.

\`\`\`json
{
  "ok": true,
  "event": {
    "id": "ntf_opaque",
    "delivery": {
      "queued": 0,
      "acceptedByProvider": 1,
      "permanentlyFailed": 0,
      "canceled": 0
    },
    "response": {
      "status": "approved",
      "action": "approve",
      "text": null,
      "correlationId": "deploy-42",
      "respondedAt": "2026-08-07T00:03:00.000Z",
      "expiresAt": "2026-08-07T00:10:00.000Z",
      "callback": { "state": "delivered", "attempts": 1, "lastStatus": 204, "lastError": null,
        "deliveredAt": "2026-08-07T00:03:01.000Z" }
    }
  }
}
\`\`\`

## Live Activity lifecycle

Scoped clients use \`POST /api/live-activities\`, \`PATCH /api/live-activities/:activityId\`, \`GET /api/live-activities/:activityId\`, and \`POST /api/live-activities/:activityId/end\`. Service-owned equivalents are under \`/hooks/<service-secret>/live-activities\`. Start, update, and end mutations accept idempotency keys and return an activity snapshot plus \`eligibleDevices\`, \`durableCommands\`, and \`apnsJobs\`.

Start request (\`activities:write\`):

\`\`\`json
{
  "key": "build-42",
  "title": "Build candidate 42",
  "status": "Starting",
  "detail": "Preparing verification",
  "progress": 0,
  "style": "standard",
  "privacy": "standard",
  "deviceIds": ["dev_opaque"],
  "expiresInSeconds": 28800,
  "staleAfterSeconds": 600
}
\`\`\`

Start/update response shape:

\`\`\`json
{
  "activity": {
    "id": "act_opaque",
    "key": "build-42",
    "status": "Running",
    "progress": 0.5,
    "state": "active",
    "sequence": 1
  },
  "delivery": { "eligibleDevices": 1, "durableCommands": 1, "apnsJobs": 1 },
  "queued": 1,
  "replayed": false
}
\`\`\`

Update request:

\`\`\`json
{ "status": "Running", "progress": 0.5, "ifSequence": 0 }
\`\`\`

End request:

\`\`\`json
{
  "status": "Complete",
  "detail": "Verification passed",
  "progress": 1,
  "ifSequence": 1,
  "dismissAfterSeconds": 15
}
\`\`\`

Read and list routes require \`activities:read\`. Mutations require \`activities:write\`.

\`style\` is \`standard\`, \`ring\` (progress drawn as a gauge with the percent inside), \`hero\`, \`terminal\` or \`steps\`, and may change on update. \`privacy: "private"\` shows only "Private activity" on the phone: title, status, detail and progress are never stored or sent, and the activity stays private across updates. An end without \`status\` reads "Complete" with a success icon. Only a start alerts; updates and ends are silent. One activity runs per phone: \`replace: true\` takes the slot. iOS budgets push-to-start, so space fresh starts about a minute apart and prefer updating one activity.

**Rate limits.** Writes count per calendar minute: 60 per CLI login or webhook service and 300 per account. A limited request returns \`429\` with \`Retry-After\` and \`retryAfterSeconds\`.

Lifecycle example:

1. Start with key \`build-42\`, title, status, optional progress, style, and target devices.
2. Update with \`ifSequence\` equal to the last returned sequence and a new idempotency key.
3. Create or wait for an interaction when human input is required; retrieve the canonical result.
4. End with final status, optional detail/progress, and \`dismissAfterSeconds\`.
5. Treat \`sequence_conflict\` or \`activity_terminal\` as authoritative state and re-read before another mutation.

## Errors and idempotency

Errors are JSON with an \`error\` code. Common codes and statuses:

- HTTP 400: \`invalid_request\`, \`invalid_device_selection\`, \`apns_payload_too_large\`.
- HTTP 401: \`unauthorized\`, \`invalid_credential\`.
- HTTP 403: \`forbidden\`, \`principal_credential_required\`, \`device_credential_required\`.
- HTTP 404: \`not_found\`, \`unknown_webhook\`, \`activity_not_found\`, \`event_response_not_found\`.
- HTTP 409: \`idempotency_conflict\`, \`sequence_conflict\`, \`activity_terminal\`, \`interaction_terminal\`, \`interaction_not_pending\`.
- HTTP 410: \`cursor_expired\`.
- HTTP 429: \`rate_limited\`; honor \`Retry-After\`. Authenticated mutations share a 300/minute account ceiling and retain a 60/minute client or service ceiling.

Health endpoints are unauthenticated and contain no secrets: \`GET /health/live\` checks the process, while \`GET /health/ready\` also verifies the database. Each successful response is \`{ "status": "ok" }\`.

The same requester and idempotency key with the same canonical request replays the stored result. Reusing it with different input returns \`idempotency_conflict\`. Generated server keys do not provide caller-controlled replay identity.
`;

export function documentationMarkdown(): string {
  return ["# Relo Notifications","","Relo coordinates durable notifications, iPhone interactions, and Live Activity lifecycle state.","",
    ...sections.flatMap((section) => [`## ${section.title}`,"",section.body,"",...(section.links ?? []).map((link) => `- ${link.label}: ${link.href}`),""]),
    machineProtocolMarkdown,"",
  ].join("\n");
}

export function agentsMarkdown(): string {
  return `${documentationMarkdown()}\n## Agent safety contract\n\nOnly an explicit phone approval authorizes a permission request; all other outcomes deny. Never send raw commands, patches, prompts, file contents, secrets, tokens, credentials, or absolute paths. Send bounded summaries and opaque identifiers only.\n`;
}

export function llmsText(): string {
  return [
    "# Relo Notifications",
    "> Private coordinated notifications, phone decisions, and Live Activities.",
    "",
    "- Documentation: /docs.md",
    "- Agent instructions: /agents.md",
    "- Dashboard documentation: /dashboard/docs",
    "- Health: /health/ready",
  ].join("\n");
}
