# ADR 0011: Computers

Status: accepted, 16 October 2026; implemented in phases (plan: `docs/internal/product/plan/11-computers.md`).
Applies [ADR 0008](0008-relo-design-framework.md) ("Devices and trust": observed device facts and the owner's
trust decisions) and [ADR 0010](0010-shared-server-modules.md) (one module per concern).

## Context

A login credential row was "the computer" in practice: its end-to-end encryption key, works, cards, Live
Activity policy and card limit all hang off `principal_api_keys.id`, and signing in again on the same
machine upserts the same row. But the row has no name the owner can change (its label is also the unique
upsert key), no icon, and the server knows nothing about the machine's own setup. Hooks credentials are
listed apart from the computer they run on. `principal_api_keys` also holds CI tokens, so a computer's
columns cannot live there.

## Decision

1. **A Computer is its own table, one-to-one with a login credential.** `computers.login_key_id` is
   `UNIQUE` and references `principal_api_keys(id) ON DELETE CASCADE`. Re-login upserts the same credential
   row, so the computer survives it. CI tokens never get a computer. No machine id is introduced.
2. **The display name is separate from the label.** `computers.display_name` is nullable (null means "use the
   label"). `principal_api_keys.label` stays the unique upsert key and a rename never edits it.
3. **Three kinds of setting, three owners.**

   | Kind | Examples | Owner | Flow |
   | --- | --- | --- | --- |
   | Appearance on the phone | display name, icon, color, card limit | the server, declared by the owner | Edited in the Dashboard (and by `relo setup` for name and icon). Applied when the server builds each card. The computer never needs these values. |
   | Machine setup | CLI version, tools, install state per tool, hooks level, profiles, defaults, which `RELO_*` are set | the computer | The CLI sends a report when something changes. Read-only on the Dashboard. |
   | Requested setup changes | hooks level, update checks, reinstall a tool's integration, update the CLI | the computer, on the owner's signed request | The server stores the request; the CLI pulls it on its own traffic, verifies the owner's signature, applies only allowlisted keys and reports the result. Environment variables on the machine always win. |

4. **One icon set**, `COMPUTER_ICONS` in contracts: `laptop`, `desktop`, `server`, `cloud`, `terminal`,
   `build`. Default when the owner has not chosen: the CLI's `machineKind` hint from its report, else
   `laptop`. The icon is an enum, not sensitive, so it travels readable even on end-to-end encrypted
   accounts.
5. **A remote setting change needs the owner's signature, verified on the computer.** A compromised server
   must not be able to reconfigure machines. The signer is the owner's iPhone (an approval card) or a linked
   browser where the CLI's trust rules accept it (not in strict mode).
6. **Ownership.** `apps/server/src/computers/` is the only place that reads or writes `computers`.
   Credential columns stay in `credentials/`; hooks credentials carry `computer_id` so the Dashboard shows
   them under their computer.

## What code review rejects

- A computer field stored on `principal_api_keys`.
- A rename that edits `label`.
- A remote setting change applied without a verified owner signature.
- A machine report carrying the value of a name setting (project, account, topic) or any environment
  variable value.
- A computer created for a CI token.

## Consequences

The Dashboard, the cards and the CLI point at one record per machine. Names and icons change without
touching credentials; the login's label remains a stable key. Reports and signed requests (later phases)
extend the same row without new tables of identity.

## Requested settings

Status: **Proposed, awaiting the owner's review.** Nothing in this section is built. It changes one existing
rule (below), so the owner accepts it before Phase 7 of the plan starts.

### The rule this changes

Today `relo setup` and `relo update` are never automatic: a person (or an agent the owner asked) runs them on
the machine (`owner/spec.mjs`, `help.mjs` and the docs say so). This section adds one exception: **they may
run because the owner asked for it from the Dashboard or the phone, with a signature the computer verifies.**
Without a valid signature nothing changes, and nothing runs unprompted by the server.

### Allowlist

One table in contracts, `COMPUTER_REMOTE_SETTINGS`, is the only set of keys a request may carry:

| Key | Values |
| --- | --- |
| `level.<harness>` | `notify`, `track`, `guide`, `optimize` |
| `approvals.<harness>` | `on`, `off` |
| `updateCheck` | `on`, `off` |
| `reinstall.<harness>` | `true` (reinstall that tool's integration) |
| `cliUpdate` | `"latest"` |

Nothing about credentials, keys, the server address, profiles, names or any environment variable. A key
outside the table is refused on the computer even when the signature is valid.

### Request table

`computer_setting_requests(id, computer_id, principal_id, settings jsonb, signer_id, signature, signed_at,
status, result jsonb, created_at, applied_at)`, with `status` one of `pending`, `applied`, `failed`,
`refused`, `superseded`. The Dashboard creates a request; a newer request for the same key supersedes the
older one. The CLI reads with `GET /api/computers/self/requests` and reports with
`POST /api/computers/self/requests/:id/result`. The Dashboard shows the state: "Waiting for your phone to
approve", then Pending, Applied, Failed with a reason, or "Refused: not signed by your phone".

### Signing input

A new input next to the answer input in `packages/cli/src/crypto/e2ee.mjs`, mirrored in the Dashboard
(`lib/e2ee/envelope.ts`) and iOS (`ReloCore/E2EE/`):

```
relo.e2e.v1 settings
<requestId>
<computer loginId>
<computer identity keyId>
<sha256 of canonical settings JSON>
<signedAt>
<expiresAt>
```

It is bound to this computer's login id and identity key id, so a signed request cannot be replayed to
another machine, and it expires. The computer remembers seen request ids in its state directory and refuses a
repeat. The server stores the signature but is not trusted to vouch for it: verification happens on the
computer, in a new `crypto/settings-verify.mjs` modelled on `answer-verify.mjs`, against the trust rules the
CLI already keeps.

### Signers

- **The iPhone is the main signer.** Creating a request in the Dashboard raises an approval card on the phone
  ("Set Claude Code to guide on studio-mac?"); approving signs the request. The owner's public server runs in
  strict mode, where only trusted devices count, so this is the path that works there.
- **A linked browser** may sign only outside strict mode, under the CLI's existing trust rules
  (`crypto/trust.mjs` `linkHolds`, `strictFor`). In strict mode a browser signature is refused.

### Applying

`packages/cli/src/owner/remote-settings.mjs` pulls, verifies and applies with the engines that already exist
(`install/plan.mjs` `setupPlan`, `hooksOffPlan`, `refreshPlan` with `applyPlan`; `owner/releases.mjs`
`runUpdate`; a new stored `updateCheck` in `shared/config.mjs`), then reports the result.

- **Pull points:** the end of `flushOutbox`, `declaredLane.drain`, `relo doctor` and `relo config pull`.
  **Never in the hook process**, whose timing budget stays unchanged and which must not run installs.
- **Environment variables always win.** A setting held by a `RELO_*` variable on the machine is not offered
  in the Dashboard ("Locked by RELO_X on this computer"), and a request for it is reported as refused.

### What code review rejects (addition)

- A request applied without verifying the signature, the computer binding and the expiry on the computer.
- A key outside `COMPUTER_REMOTE_SETTINGS`, or a pull from the hook process.
- A change that overrides an environment variable.
- A browser signature accepted in strict mode.
