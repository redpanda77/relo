# Dashboard Architecture

## Boundary rule

The React application is organized by user capability:

```text
app and layouts
  Inbox
  Connections
  Test Lab
  Account

features use
  product components
  generated shadcn/ui components
  feature services and hooks

server owns
  authentication and account scope
  database projections
  lifecycle policy and generation invariants
  route activation
```

Feature presentation code never defines notification lifecycle semantics. It receives validated page models and invokes task-oriented services. Hono remains the authorization and durable command boundary.

## Dependency direction

1. `app` chooses the active capability and composes the shared layout.
2. `features/<capability>` owns its pages and domain-specific composition.
3. `state` and `services` own decoding, fetching, polling, pending operations, and recoverable errors.
4. `components/organisms`, `molecules`, and `atoms` contain reusable product presentation below the feature boundary.
5. `components/ui` contains official generated shadcn/ui source and imports no feature code.
6. `lib` contains small deterministic primitives such as semantic status-to-tone mapping.

Dependencies point down this list. Components do not call `fetch`, read bootstrap JSON, query the database, or infer lifecycle truth.

## Composition rules

- Prefer direct composition of existing shadcn/ui components.
- Add a product component only when it has multiple real consumers or owns a complete reusable product region.
- Do not create a wrapper used once merely to rename a ShadCN prop or Tailwind class.
- Keep semantic status mapping and design tokens centralized.
- Do not turn the status vocabulary into a generic notification rendering framework.
- Keep route state explicit and feature-specific.
- Preserve native controls where phone mechanics matter, including native select behavior and mobile safe-area handling.

## Current capability ownership

| Capability    | React ownership                                             | Data boundary                                                                      | Remaining seam                                                        |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Inbox         | Overview, notification history, detail, delivery, approvals | `services/inbox-service.ts`, Inbox bootstrap schemas, snapshot and action hooks    | Activate the isolated server projection in the final route cutover    |
| Connections   | Services, phones, clients, secrets, revocation              | `services/connections-service.ts` and typed Connections bootstraps                 | Activate the isolated server projection in the final route cutover    |
| Test Lab      | Monitor, New Run Sheet, Run Details Sheet, previews, history| `services/test-lab-service.ts`, Test Lab bootstrap schema, draft and polling hooks | Extract the remaining Test Lab page projection from the legacy router |
| Account       | Identity, password change, deletion                         | `services/account-service.ts` and typed Account bootstrap                          | Activate the isolated server projection in the final route cutover    |
| Documentation | Workflow guidance and stable machine-readable links         | Typed Documentation bootstrap                                                      | Activate the isolated server projection in the final route cutover    |
| Authentication| Sign in and first-owner creation                            | `features/auth/auth-service.ts` and typed Auth bootstrap                           | Replace the public server-rendered authentication document            |

## Concrete debt addressed

- React, Vite, Tailwind, Radix, and generated ShadCN now have a dedicated workspace instead of living inside server HTML strings.
- Inbox and Test Lab have feature-level services and hooks rather than document queries and global browser state.
- Mobile navigation uses the generated ShadCN Sidebar and Sheet mechanics.
- Test Lab drafts persist independently from durable server state.
- Test Lab launch responses retain activity ID, generation, sequence, and reuse/resume evidence across the route reload without inventing client lifecycle state.
- Server, provider, phone, ActivityKit, and response evidence remain separate projections in the run detail view.
- Inbox and Test Lab share one typed semantic status tone vocabulary and one token layer.
- Compact rows replace wide enterprise tables while preserving durable evidence and deep links.
- Active motion is scoped to live state and has a reduced-motion fallback.

## Abstractions deliberately avoided

- No generic notification component registry.
- No dashboard-wide global state store.
- No universal repository or API adapter over the feature services.
- No base page class or one-use layout wrappers.
- No client-side lifecycle state machine that competes with server truth.
- No replacement for Radix focus, portal, dialog, Sheet, Sidebar, or native select mechanics.
- No duplicated server authorization or account scoping in React.

## Change gate

Before extracting or splitting an existing shared component:

1. Use GitNexus context and upstream impact analysis.
2. Warn on HIGH or CRITICAL blast radius.
3. Update the smallest interface first.
4. Update the implementation.
5. Update every consumer.
6. Update focused tests.
7. Run typecheck, ESLint, production build, accessibility and viewport checks.
8. Run GitNexus `detect_changes` before the commit.

## Remaining server seams

- `apps/server/src/web.ts` remains the high-risk route registry. The cutover changes only route-handler assignment after every account-scoped projection exists in an isolated module.
- `apps/server/src/web/dashboard-app.ts` is the approved React document/bootstrap seam.
- `apps/server/src/web/dashboard-inbox.ts` owns the account-scoped Inbox projection and must stay aligned with lifecycle history semantics.
- `apps/server/src/web/dashboard-connections.ts`, `dashboard-system.ts`, `dashboard-auth.ts`, and `dashboard-activity-history.ts` own capability-specific projections without defining lifecycle policy.
- The Test Lab projection is the last route that must be extracted from `dashboardPage` before legacy dashboard rendering can be deleted.
- Relo server receives exact committed archives from this laptop. Working-tree or partial-index builds are not deployment inputs.

## Generation contract consumption

The Dashboard consumes lifecycle contract commits `c31a226` and `f329c9a` without reproducing their allocation rules:

- the service decoder requires a positive activity generation and explicit `reused` and `resumed` mutation metadata;
- repeated default launch remains `allowParallel: false` and therefore targets the current origin generation;
- the diagnostics control is the only UI path that may send `allowParallel: true`, and labels that choice as a distinct diagnostic origin;
- the most recent launch receipt is kept only in browser session storage so reuse/resume feedback survives the server-backed route reload;
- bootstrap and polling data remain authoritative for activity state, generation, sequence, and evidence;
- absence of ActivityKit evidence is shown as unreported, never inferred from a phone receipt or APNs state.
