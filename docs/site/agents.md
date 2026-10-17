---
title: For agents
summary: The rules an AI agent follows to keep the owner's iPhone current: one work per goal, real words, ask before risky actions, finish once.
---

You are an agent working for the owner. Relo shows your work as one live card on their iPhone and lets
you ask them before a risky step. Follow these rules. Every `relo` command prints the plan, what the
owner sees and the exact next command: read it.

```sh
relo work start --goal "Fix the login crash" --plan "Reproduce the crash,Find the cause,Choose the fix"
relo work update --status "Reproduced on iOS 17" --next-step
relo work update --add "Patch token refresh,Run the tests"
relo ask "Deploy 0.7.57 to production?" --approval
relo work finish --outcome "Login fixed: token refresh patched and tested"
relo state
```

## When to use it

- Any work longer than a couple of minutes: start a work before your first change.
- Before a risky or irreversible action (deploy, delete, migrate, spend): ask, and wait for `approved`.

## One work per goal

- Start once per goal, with the goal in the owner's words. A repeat `relo work start` continues the open
  work; it does not make a second card.
- A different goal: `relo work start --new --goal "…"`. The old one is parked; `relo work resume`
  brings it back.
- No session id in your harness (Gemini CLI, Cursor)? Pass the handle `start` prints as
  `--work` on later commands.

## Plan honestly

- Steps are milestones in order, only your own work. What the owner must do is a question, never a step.
- Unsure how to solve it? Plan how you will find out ("Reproduce the bug,Find the cause,Choose the
  fix"), then grow the plan in place with `--add`. `--plan "…"` on update lists what is left: done
  steps stay, steps you leave out are skipped. The plan is for the owner's visibility, not a contract.
- Move on with `--next-step` at real milestones, not on every tool call, and the moment one is done:
  the owner reads the card, not your chat, so a step you report in chat but not on the card leaves it
  a step behind.
- Run each `relo` command alone and read all of its output, never through `>/dev/null`, `tail`, `head`
  or `grep`: `Owner sees:` confirms what reached the phone.
- Parallel work (several jobs, subagents) is one step with a count: `--progress 2/6`. A counted job
  without a plan: `--progress 3/10`. Never guess progress from time.
- Ending your turn while CI, a review or a background job (a deploy, a long test run) runs:
  `relo work update --waiting "the deploy"`. A stopped turn is otherwise the owner's turn ("waiting on
  you"); the declared wait keeps the card moving for up to an hour. Clear it with `--not-waiting`. Stepping away:
  `relo work pause --status "…"`.

## Real words only

- Write what the owner understands at a glance: "Running the migration tests", not "Step 2" or "todo".
- Never put secrets, tokens, environment variables, hostnames, absolute paths, raw commands, prompts or
  file contents in card text. Summarise in a short sentence.

## Ask before risky actions

```sh
relo ask "Delete the staging database?" --approval --detail "Frees 40 GB. It is rebuilt nightly."
```

- One exact action per question, one line of at most 120 characters. The why and the risk go in
  `--detail`. If the action changes, ask again.
- `--yes-no` or `--option` are for preferences, never permission.

:::never Only approved is permission
Proceed only when an `--approval` question returns exit 0 with state `approved`. Denied, no, expired,
canceled, a timeout, an error, malformed output, or a late answer seen in a later echo all mean no.
Exit 0 alone is not enough: a yes also exits 0.
:::

- Exit 4 means the question is still open: run `relo interaction wait ID` (it waits up to {{fact question.agentWaitSeconds}}
  per command). Exit 8 means it closed unanswered: do not act.

## Finish once

- `relo work finish --outcome "…"` says what happened, honestly. The outcome is the owner's
  notification.
- Add `--failed` when it did not succeed, `--dropped` when you abandoned it.
- `relo notify "…"` only when no work is open and an outcome is worth a buzz. Never for progress or
  questions.

## Stay in your lane

- Subagents run no relo commands. The orchestrating agent owns the card and counts subagents in one
  step.
- You see only your own session's work. Cross-session commands (`relo admin works`,
  `relo admin finish`) only when the owner asks you to clean up.
- `relo setup`, hooks and sign-in are the owner's choices. Run them only when asked. Run `relo update`
  when a relo reply says the CLI is behind your server's. If
  a command fails with an auth or no-phone error, run `relo doctor` and follow its `next.run`, asking the
  owner once per step.

## Lost track

After compaction, a restart or a break, run `relo state`: it shows what this session has open and
parked, and the next command. A change that could not be sent is queued and goes out with your next
command.

Exit codes: [reference](/docs/reference/exit-codes). Every flag: `relo help all`, or the
[CLI reference](/docs/reference/cli).
