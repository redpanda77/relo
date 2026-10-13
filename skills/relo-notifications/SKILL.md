---
name: relo-notifications
description: Show the owner your work live on their iPhone (Lock Screen and Dynamic Island card via self-hosted Relo) and ask approval or yes/no questions on it. Use whenever work will take more than a minute or two, whenever you need the owner's go-ahead or a yes/no, and when the user says "keep me posted", "show progress on my phone", "ping me when it's done", "ask me before you deploy", or "let me know", even without saying Relo. Also use to check, authenticate, or update Relo.
---
# Relo: your work, live on the owner's iPhone

```bash
relo activity start --title "Deploying 0.7.57" --status "Building" --steps "Build,Test,Ship" --topic "Release 0.7.57"
relo activity update --status "Running tests" --next-step    # judgment work: named steps; send only the change
relo activity start --title "Polishing chapters" --status "Chapter 3" --progress 3/20 --topic "Book edit"   # counted job
if relo ask "Deploy 0.7.57 to production?" --approval; then ./deploy.sh; fi   # 5 denied, 4 no answer: don't
relo activity end --status "Live on production"
```

**The card** is the tool, for work that is happening or waiting on the owner. `relo notify "…"` is a
rare buzz for a finished outcome. Never a question, never progress. **One card per agent**: in an agent
session (Claude Code, Codex, OpenCode, Gemini CLI, Cursor; any other harness: `RELO_SOURCE="<harness>"` and
`RELO_SESSION=<stable id>`) every command lands on the session's card; a second start, update or ask never makes
another. Elsewhere reuse the same `--topic`. Flags: `relo help all`, `relo schema activity update`.

## Identity
Every start, ask and notify requires nonempty source, project, and topic. Only the **topic** is
yours: the work as the owner would name it. Source, project, computer and account are automatic; with
several agent accounts run `relo account NAME` once in each.

## First run
Only after a relo command fails with an auth or no-phone error, or `relo doctor` says `ready:false`. Run `next.run` for the first unmet `next.step`; ask the owner at most once per step:
- `login`: `relo auth login` prints `{state:"pending",url}` and returns; give the owner the url, then run
  `relo auth login --wait` (exit `4` pending: run it again).
- `phone`: the owner opens the Relo app, signs in, allows Live Activities. `test`: run `relo test` once.
- Never re-ask a finished step. `relo setup` (`--hooks`, `--mcp` optional) only if the owner asks, for the one file they pick.
  Missing CLI: [install](references/install.md). Skill: `relo skill install --agent <yours>`; CLI behind: `relo update`. Ask first.

## Output
One compact JSON line (`{"ok":true,"id":"act_…","state":"active","sequence":3,"step":"2/5"}`); `--full`
prints everything. Errors print once: `{"ok":false,"error":{code,message,hint}}`.
Exit `0` ok · `1` server · `2` usage · `3` auth (`relo auth login`) · `4` no answer in time · `5` owner
said no · `6` network (retry with the same `--idempotency-key`) · `7` no phone got it.
In an agent session `ask` waits ~100s; exit `4` with state `timeout` means the question is still
open: `relo interaction wait ID`. Other `4` states are closed: do not act.

## Keep the card honest
1. Start early; update on real milestones (a phase, a blocker), not every tool call.
2. Progress is measured or absent. Judgment work: `--steps` (3-6 phases the owner would recognize,
   `--next-step`). A script or counted job (10 images, 400 rows): `--progress 3/10`. Never both on one
   card; never a percentage guessed from time.
3. Ask only when the work depends on the answer: under 240 characters, self-contained.
4. End exactly once, honestly (`--symbol warning` on failure). Leave `--style`/`--privacy` alone.

## Non-negotiable safety
- A permission may proceed only after an `approval` question returns state `approved` from the
  server. A yes/no answer is never permission. Exit `0` alone never authorizes anything, because
  "yes" also exits `0`.
- Denial, `no`, expiry, timeout, cancellation, malformed output, auth or network failure all mean
  no. Never infer approval from an alert, a tap, or local state.
- Never put raw commands, prompts, file contents, patches, secrets, tokens, environment variables,
  transcripts, hostnames, or absolute paths in card text. The CLI attaches the computer name and
  account nickname itself; write a short, purpose-made summary instead.
- Describe one exact action per approval. If the action changes, ask again.
- Credentials come only from the CLI's protected config, or `RELO_TOKEN` when an operator set it for
  CI. Never print them or pass them as flags.

More, when needed: [security](references/security.md) (before sending anything sensitive),
[cards](references/cards.md), [cli](references/cli.md), [troubleshooting](references/troubleshooting.md),
[services](references/services.md), [install](references/install.md).
