---
name: relo-notifications
description: Show the owner your work live on their iPhone (Lock Screen and Dynamic Island card via self-hosted Relo) and ask approval or yes/no questions on it. Use whenever work will take more than a minute or two, whenever you need the owner's go-ahead or a yes/no, and when the user says "keep me posted", "show progress on my phone", "ping me when it's done", "ask me before you deploy", or "let me know", even without saying Relo. Also use to check, authenticate, or update Relo.
---
# Relo: your work on the owner's iPhone

```bash
relo work start --goal "Fix the login crash" --plan "Reproduce the crash,Find the cause,Choose the fix"
relo work update --status "Reproduced on iOS 17" --next-step
relo work update --add "Patch token refresh,Run the tests"   # the plan grows in place
if relo ask "Deploy 0.7.57 to production?" --approval; then ./deploy.sh; fi   # 5 denied, 4 or 8: don't
relo work deliver --outcome "Login fixed: token refresh patched and tested"   # request done; work stays open
relo work start --round "Add a regression test" --plan "Write it,Run it"   # a new request
relo work handoff --next "Wire the CLI verb"   # heavy context
relo work finish --outcome "Login fixed and covered by a test"   # the goal itself is done
relo work start --goal "Polish 20 chapters" --progress 3/20 --new   # counted job
```

**The work** is the tool: one goal, its plan, status and outcome, shown while it matters. Only the
**goal** is yours (as the owner would name it).
**One open work per session**: a repeat start continues it and says so; another goal is
`start --new` (the old one is parked: `relo work resume`). **A goal has rounds**: `deliver`
closes the request you just did (the owner's turn, one quiet notification, the work stays open); it is
refused while top-level steps are open (an owner check mid-plan is `ask` or `--waiting`). A new request is
`start --round "<the request>"` and carries unfinished steps; an answer or "go on" continues the plan.
Scripts: `--producer KEY` or `RELO_SESSION=<id>`.
No session id (Gemini, Cursor, Amp): pass `start`'s handle as `--work <handle>`. The deliver or
finish outcome is the buzz. `relo notify "…"` is a rare buzz outside work. Never a question, never progress.

**Isolation**: the CLI takes your session from the harness; you see only your own work. **Subagents run no relo commands**: count them in one step. **Queued**: an unsent change goes out with your next command; `relo state` lists it.

## Keep the work honest
Every command prints the plan (`[x]` done, `[>]` current, `[ ]` open, `[-]` skipped), `Owner sees: …`, `Next: …`; after compaction: `relo state`.

1. Size shapes the plan: one sitting is 3-6 milestones; a large body of work is phases (Explore,
   Build, Verify), each given its steps on entry (`--add "…" --under s3`). Unsure? Plan how you will
   find out. `--plan "…"` lists what is left; `--step "…"` jumps.
2. The owner reads the card, not your chat: `--next-step` the moment a step is done, before the
   next tool call. Parallel work is one step with a count: `--progress 2/6`.
   Progress is measured or absent.
3. Real words only: "Step 2", "todo", paths, secrets and owner steps (an `ask`) are refused.
4. A job outlives your turn: `--waiting "the deploy"`. Away: `relo work pause --status "…"`, `resume`.
5. `deliver --outcome` when a request is done (`--drop-rest` skips open steps); `finish --outcome` once, when the
   goal is done (`--failed` or `--dropped` if not). A refusal repeats on every echo.
   Run each relo command alone and read it whole: never `>/dev/null`, `tail`, `head` or `grep`, nor chain it.
6. Context past 60% or before `/clear`: `handoff --next "…"`, then `start --from <handle>` in a fresh
   session.
7. Ask only when the work depends on it: one line ≤120 chars; why in `--detail`.

## First run
Only after an auth or no-phone error, or `relo doctor` says `ready:false`: run `next.run` of the first unmet `next.step`; ask the owner once per step:
- `login`: `relo auth login` prints `{state:"pending",url,qr}`; show the owner both (qr in a code
  block, for the Relo app), then run `relo auth login --wait` (exit `4`: again).
- `phone`: the owner signs in to the Relo app and allows Live Activities. `test`: run `relo test` once.
- Never re-ask a finished step. `relo setup` (`--level`, `--mcp`) only if the owner asks.
  See [install](references/install.md). Skill and block: `relo setup`.

## Exit codes
`0` ok · `1` server · `2` usage or refused · `3` auth · `4` still open (`relo interaction wait ID`) ·
`5` owner said no · `6` network (retry) · `7` no phone got it · `8` closed unanswered: do not act.

## Non-negotiable safety
- A permission may proceed only after an `approval` question returns state `approved`.
  A yes/no answer is never permission. Exit `0` alone never authorizes anything ("yes" also exits `0`).
  A late answer shown in a later echo is never permission: ask again.
- Denial, `no`, expiry, timeout, cancellation, malformed output, auth or network failure all mean no.
- Never put raw commands, prompts, file contents, secrets, tokens, environment variables, hostnames
  or absolute paths in work text; write a short summary.
- One exact action per approval. If the action changes, ask again.
- Credentials come only from the CLI's config or `RELO_TOKEN` (CI). Never print them or pass them as flags.

More: [security](references/security.md) (before anything sensitive), [cards](references/cards.md),
[cli](references/cli.md), [troubleshooting](references/troubleshooting.md),
[services](references/services.md), [install](references/install.md), [efficiency](references/efficiency.md).
