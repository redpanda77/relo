# Relo roadmap

Relo is a source-available, self-hosted developer notification and phone-decision system. This
roadmap describes the current product contract and the next adopter-facing outcomes. Historical
release evidence and environment-specific operations are intentionally not part of this document.

<!-- current-truth:start -->
Current baseline: server, worker, and Dashboard `0.9.11`, CLI/notifier/skill `0.9.2`, and iOS
`0.9.19` build `31` source-only.
<!-- current-truth:end -->

## Product contract

Run one server, connect an iPhone by QR, authenticate the CLI through a browser approval link, and
send durable notifications, decisions, and Live Activity progress to that phone.

- PostgreSQL is the source of canonical state.
- The worker owns APNs delivery attempts and retries.
- APNs acceptance and phone application are reported as separate facts.
- The CLI is the primary control and diagnosis interface.
- Hooks are optional reduced-context adapters, never a prerequisite or source of truth.
- A server origin is selected explicitly during setup and retained with the scoped CLI credential.
- Relo is licensed for noncommercial use under PolyForm Noncommercial 1.0.0.

## Available now

- Docker Compose self-hosting with a restricted runtime database role.
- First-owner setup, account management, and QR-based iPhone connection.
- Browser-link-first CLI authorization with page-and-code fallback.
- Notifications, approval/yes-no/text decisions, and Live Activities.
- Delivery diagnosis across server, worker, APNs, and exact phone receipt boundaries.
- Dashboard history, device/client/service administration, and connection guidance.
- Native iOS inbox, ActivityKit presentation, recovery, and authenticated receipts.
- Allowlisted public export, public CI, noncommercial licensing, and security reporting guidance.
- Global Agent Skill installation through `npx skills`.

## Next outcomes

### 1. Independent installation proof

- A developer without maintainer-local context completes the README from a clean computer.
- The GitHub `npx skills add redpanda77/relo@relo-notifications` flow installs exactly one skill.
- Setup failures identify the broken boundary and provide a safe recovery command.
- The complete first notification journey is verified on a physical iPhone.

### 2. Operational clarity

- The Dashboard and CLI use the same vocabulary for server, worker, APNs, and phone state.
- Ambiguous provider outcomes always require explicit reconciliation before retry.
- Backup, update, rollback, and uninstall procedures remain bounded and testable.
- Logs and diagnostics remain useful without exposing credentials or notification content.

### 3. Distribution readiness

- Source releases remain reproducible from the reviewed allowlist.
- Any future npm or container publication requires artifact inventory, SBOM, secret and license
  scanning, provenance review, and clean-host lifecycle evidence.
- iOS signing, installation, and App Store distribution remain user-owned until a separate release
  process is reviewed.

## Contribution priorities

Changes should improve one of these adopter outcomes:

1. fewer steps from clone to first phone delivery;
2. clearer diagnosis when delivery stops at a boundary;
3. safer credentials, updates, and recovery;
4. more legible native notification and Live Activity presentation; or
5. smaller, better-tested seams in the modular monolith.

Large framework rewrites, speculative microservices, and hooks as a primary workflow are out of
scope. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
