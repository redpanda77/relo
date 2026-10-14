# Dashboard Architecture

## Boundary rule

The React application is organized by user capability:

```text
app and layouts
  Landing (signed out)
  Authentication
  Now and History
  Projects
  Connections
  Test Lab
  Account
  Documentation

features use
  product components
  generated shadcn/ui components
  feature services and hooks

server owns
  authentication and account scope
  database projections
  lifecycle policy and generation invariants
  routes and page bootstraps
```

Feature presentation code never defines notification lifecycle semantics. It receives validated page models and invokes task-oriented services. Hono remains the authorization and durable command boundary.

## Routing and bootstraps

Every page is a server route that renders the same Vite document with a JSON bootstrap; `app/dashboard-app.tsx` switches on `bootstrap.kind`. There is no client router library: `app/dashboard-router.tsx` intercepts `/dashboard*` links, fetches the next document and parses its bootstrap (`dashboard-route-loader.ts`), caches it briefly, prefetches on hover or focus, and restores scroll. Page code is lazy-loaded and preloaded when the browser is idle (`dashboard-page-loaders.ts`). On a linked browser the bootstrap may be sealed and is opened in the browser (`app/sealed-bootstrap.ts`, `lib/e2ee`).

| Route | `kind` | Feature |
| --- | --- | --- |
| `/` signed out on a claimed server | `auth` (landing view) | `features/landing` |
| `/sign-in`, and `/` on an unclaimed server or with `?next=` | `auth` (form view) | `features/auth` |
| `/dashboard` (Now) | `inbox-overview` | `features/inbox` |
| `/dashboard/inbox/notifications[/:id]` (History, detail) | `notification-history`, `notification-detail` | `features/inbox` |
| `/dashboard/inbox/delivery` | `delivery-history` | `features/inbox` |
| `/dashboard/projects[/:projectId]` | `projects` | `features/projects` |
| `/dashboard/connections` | `connections` | `features/connections` |
| `/dashboard/testing[/runs/:activityId]`, `…/history` | `test-lab`, `activity-history` | `features/test-lab` |
| `/dashboard/account` | `account` | `features/account` |
| `/dashboard/docs` | `docs` | `features/docs` |

Signed in, `/` and `/sign-in` redirect to `/dashboard`. Retired paths (`/dashboard/inbox`, `/dashboard/approvals`, `/dashboard/notifications`, `/dashboard/delivery`, `/dashboard/services|devices|clients`) redirect to their current page.

## Dependency direction

1. `app` reads the bootstrap, chooses the active capability and composes `layouts/dashboard-shell.tsx`.
2. `features/<capability>` owns its pages and domain-specific composition. Account composes the smaller settings features (`two-factor`, `devices`, `encryption-policy`, `presentation-policy`, `linked-browser`, `pending-devices`).
3. `state`, `services` and a feature's own `*-service.ts` own decoding, fetching, polling, pending operations, and recoverable errors.
4. `components/organisms`, `molecules`, and `atoms` contain reusable product presentation below the feature boundary; they import feature types only.
5. `components/ui` contains generated shadcn/ui source and imports no feature code.
6. `lib` contains small deterministic primitives (status-to-tone mapping, formatting) and the browser's end-to-end encryption (`lib/e2ee`).

Dependencies point down this list. Presentation components do not read bootstrap JSON, query the database, or infer lifecycle truth. Bootstrap and API shapes come from `@relo/notification-contracts`; each feature's `types.ts` re-exports them.

## Composition rules

- Prefer direct composition of existing shadcn/ui components.
- Add a product component only when it has multiple real consumers or owns a complete reusable product region.
- Do not create a wrapper used once merely to rename a ShadCN prop or Tailwind class.
- Keep semantic status mapping and design tokens centralized.
- Do not turn the status vocabulary into a generic notification rendering framework.
- Keep route state explicit and feature-specific.
- Preserve native controls where phone mechanics matter, including native select behavior and mobile safe-area handling.

## Capability ownership

| Capability | React ownership | Data boundary |
| --- | --- | --- |
| Landing | Signed-out page: hero scene, value proposition, demos | Static; the `auth` bootstrap chooses it |
| Authentication | Two-step sign-in, sign-up (open or by approval), first-owner creation | `features/auth/auth-service.ts` and the `auth` bootstrap |
| Now and History | Needs you, sessions, live work, history, detail, delivery, answers | `services/inbox-service.ts`, inbox bootstraps, snapshot and action hooks |
| Projects | Projects, aliases, merge and split | `services/projects-service.ts` and the `projects` bootstrap |
| Connections | Services, phones, clients, secrets, revocation | `services/connections-service.ts` and the `connections` bootstrap |
| Test Lab | Monitor, New Run Sheet, Run Details Sheet, previews, history | `services/test-lab-service.ts`, draft and polling hooks |
| Account | Security (two-factor, devices, encryption), command line, server, shared access, preferences, sign-in, deletion | `services/account-service.ts`, the settings features' own services, and the `account` bootstrap |
| Documentation | Workflow guidance and stable machine-readable links | The `docs` bootstrap |

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

## Server seams

- `apps/server/src/web.ts` is the route registry.
- `apps/server/src/web/dashboard-app.ts` renders the document and bootstrap, serves `/assets/*` from `apps/dashboard/dist`, and lists the landing chunk's preloads from the Vite manifest.
- `apps/server/src/web/dashboard-auth.ts` chooses landing or form for `/` and `/sign-in`.
- `dashboard-inbox.ts`, `dashboard-projects.ts`, `dashboard-connections.ts`, `dashboard-system.ts` and `dashboard-activity-history.ts` own capability-specific projections without defining lifecycle policy.
- The Test Lab projection is still inline in `web.ts` (`testLabPage`).
- The iPhone's browser sign-in (`/mobile/sign-in`), CLI authorization (`/cli/authorize`) and the 404/500 pages are server-rendered pages, not part of this app; they mirror its tokens through `web/public-page.ts`.
- Relo server receives exact committed archives. Working-tree or partial-index builds are not deployment inputs.

## Generation contract consumption

The Test Lab consumes the lifecycle generation contract without reproducing its allocation rules:

- the service decoder requires a positive activity generation and explicit `reused` and `resumed` mutation metadata;
- every launch sends `allowParallel: false` and therefore targets the current origin generation;
- the most recent launch receipt is kept only in browser session storage so reuse/resume feedback survives the server-backed route reload;
- bootstrap and polling data remain authoritative for activity state, generation, sequence, and evidence;
- absence of ActivityKit evidence is shown as unreported, never inferred from a phone receipt or APNs state.
