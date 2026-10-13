---
name: relo-notifications
description: Give the owner a live view of your work on their iPhone through self-hosted Relo, as a Live Activity on the Lock Screen and Dynamic Island that you keep updated, and ask them approval or yes/no questions right on it. Use whenever work will take more than a minute or two, whenever you need the owner's go-ahead or a yes/no before continuing, and when the user says things like "keep me posted", "show progress on my phone", "ping me when it's done", "ask me before you deploy", or "let me know", even if they never say Relo. Also use to check, authenticate, or update Relo itself.
---
# Relo: a live view of your work on the owner's iPhone

`relo` shows the owner what you are doing as a **Live Activity card** on their Lock Screen and in
the Dynamic Island. You keep the card current, ask questions on it, and end it when the work ends.
Notifications are the exception, not the tool. `relo help` prints the recipes; `relo schema` lists
every command and flag as JSON.

## The one rule

| If the work is… | Use | Why |
| --- | --- | --- |
| Still happening, or waiting on the owner | **The card**: `relo activity start` → `update` → `end`, and `relo ask` | The owner glances at one card that is always current |
| Finished, and worth interrupting them for | **A notification**: `relo notify` | A one-time buzz for an outcome. Never a question, never progress |

**One card per agent.** Inside Claude Code or Codex every `relo` command lands on that session's card,
so a second `activity start`, an update, or a question never creates another card. Several agents
running at once each get their own card. Outside an agent session the card is source › project ›
topic, so keep using the same `--topic`.

## Identity: who › what › why

Every new notification, standalone ask, and activity start/ensure requires nonempty source,
project, and topic: `--source`, `--project`, `--topic` (`--thread-name` is the topic alias).
- **Source** and **project** usually resolve themselves: the CLI recognizes Claude Code, Codex and
  OpenCode, and uses the git repository name. `RELO_SOURCE` / `RELO_PROJECT` override detection.
- **Topic is yours to name**, the way the owner would: "Release 0.7.57", "Homepage redesign".
  `RELO_TOPIC` sets it for a session. Generic values ("Project", "Task") are rejected.
- Missing/blank identity is a usage error (exit `2`) that lists every missing field and prints a
  `hint` with a corrected command: run the hint rather than retrying with fewer fields.
- Updates and ends inherit stored identity; pass identity only when creating.

## Recipes

```bash
relo activity start --title "Deploying 0.7.57" --status "Building image" --progress 0.2 --topic "Release 0.7.57"
relo activity update --status "Pushing image" --progress 0.7

if relo ask "Deploy 0.7.57 to production?" --approval; then   # buttons on the card; waits up to 5 minutes
  ./deploy.sh                                               # exit 0 = approved (see safety)
fi                                                          # 5 = denied, 4 = no answer (card ended): do not deploy

relo activity end --status "Live on production"
relo notify "0.7.57 is live on production" --title "Deployed" --topic "Release 0.7.57"  # only if worth a buzz
```

Branch on the exit code, then read the single JSON line on stdout (`data`, or `error.code` and
`error.hint`). `0` ok · `1` server · `2` usage · `3` auth (`relo auth login`) · `4` no answer in
time · `5` owner said no · `6` network (retry with the same `--idempotency-key`) · `7` no phone got it.

## Keeping the card honest

1. **Start early, update on real milestones**: a new phase, a measured step, a blocker. Not every
   tool call, and not on a timer: each update should tell the owner something new.
2. **Progress is measured or absent**: units done / total, or named `--step`s with `--step-current`.
   Never estimate a percent from elapsed time or confidence.
3. **Ask on the card** only when the work truly depends on the answer. Keep questions under 240
   characters and self-contained. Answers are tappable only: `--approval` or `--yes-no`.
4. **End exactly once**, with an honest status ("Live", "Failed: tests", "Stopped"). A successful
   end completes every step and fills progress; end with `--symbol warning` when the work did not
   succeed, so History keeps where it stopped. A card that stops updating goes stale after 20 minutes
   and ends itself 10 minutes later, but end it yourself.
5. Leave appearance flags (`--style`, `--theme`, `--privacy`) alone unless the owner asks.

## Non-negotiable safety

These rules exist because a phone answer can unlock real actions and card text leaves the machine.
- A permission may proceed only after an `approval` question returns state `approved` from the
  server. A yes/no answer is never permission. Exit `0` alone never authorizes anything, because
  "yes" also exits `0`.
- Denial, `no`, expiry, timeout, cancellation, malformed output, auth or network failure all mean
  no. Never infer approval from an alert, a tap, or local state.
- Never send raw commands, prompts, file contents, patches, secrets, tokens, environment variables,
  transcripts, hostnames, or absolute paths. Write a short, purpose-made summary instead.
- Describe one exact action per approval. If the action changes, ask again.
- Credentials come only from the CLI's protected config, or `RELO_TOKEN` when an operator set it for
  CI. Never print them or pass them as flags.

Read [references/security.md](references/security.md) before sending anything sensitive.

## Read more only when the task needs it

| Read | When |
| --- | --- |
| [references/cards.md](references/cards.md) | Planning a card for long or exploratory work: steps vs progress, statuses, styles, ending |
| [references/cli.md](references/cli.md) | Exact flags, JSON shapes, links (`--url`), callbacks, stdin |
| [references/troubleshooting.md](references/troubleshooting.md) | Auth, network, a missing or stale card, timeouts, sequence conflicts |
| [references/services.md](references/services.md) | Creating or using webhook services (secret URLs) |
| [references/install.md](references/install.md) | Maintainers only: installing or updating the CLI and this skill |

Before publishing or installing this skill, run `node scripts/validate-skill.mjs` and `node --test tests/*.test.mjs`.
