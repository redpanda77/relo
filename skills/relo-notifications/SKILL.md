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
relo work finish --outcome "Login fixed: token refresh patched and tested"
relo work start --goal "Polish 20 chapters" --progress 3/20 --new   # counted job
relo state   # what this session has open
```

**The work** is the tool: one goal, its plan, status and outcome, shown while it matters. Only the
**goal** is yours (as the owner would name it); the rest is automatic.
**One open work per session**: a repeat start continues it and says so; another goal is
`start --new` (the old one is parked: `relo work resume`). Scripts: `--producer KEY` or `RELO_SESSION=<id>`.
No session id (Gemini CLI, Cursor): pass `start`'s handle as `--work <handle>`. The finish
outcome is the buzz. `relo notify "…"` is a rare buzz outside work. Never a question, never
progress.

**Isolation**: the CLI takes your session from the harness; you see only your own work. **Subagents run no relo commands**: you own the work and count them in one step. **Queued**: an unsent change is kept ("Queued: sends with the next relo
command") and goes out first with your next command; `relo state` lists it. **Hooks** are
optional (owner's choice): they report only your session's phase, never change work or questions.

## Keep the work honest
Every command prints the plan (`[x]` done, `[>]` current, `[ ]` open, `[-]` skipped), `Owner sees: …`, `Next: …`; a refusal is three lines (what, state, next). After compaction: `relo state`.

1. Plans emerge. Unsure? Plan how you will find out, then `--add "A,B"`. `--plan "…"` lists what is
   left (done steps stay; steps left out are skipped); `--step "…"` jumps. Not a contract.
2. Steps are milestones in order. Parallel work is one step with a count: `--progress 2/6`
   counts the current step. Progress is measured or absent: `--progress 3/10` for a counted job
   without a plan.
3. Real words only: "Step 2", "todo", paths, secrets and owner steps (an `ask`) are refused.
4. Outside wait: `--waiting "CI"`. Away: `relo work pause --status "…"`, `resume`.
5. Finish once, honestly: `--outcome`, plus `--failed` or `--dropped` when it is not a success.
6. Ask only when the work depends on it: one line ≤120 chars; why in `--detail`.

## First run
Only after an auth or no-phone error, or `relo doctor` says `ready:false`: run `next.run` of the first unmet `next.step`; ask the owner once per step:
- `login`: `relo auth login` prints `{state:"pending",url}` and returns; give the owner the url, then run
  `relo auth login --wait` (exit `4`: again).
- `phone`: the owner signs in to the Relo app and allows Live Activities. `test`: run `relo test` once.
- Never re-ask a finished step. `relo setup` (`--hooks LEVEL`, `--mcp`) only if the owner asks.
  See [install](references/install.md). Skill: `relo skill install --agent <yours>`.

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
[services](references/services.md), [install](references/install.md).
