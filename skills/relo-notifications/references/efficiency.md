# Working lean

Optional. Relo never forces any of this; it is how to spend fewer tokens without losing the owner's view.
The owner turns it on with `relo setup --level optimize`.

## Subagents

- Named agents at optimize: `relo-explore` (small model, read-only tools) for searching and reading, and
  `relo-worker` (mid model) for well-specified changes. Use them as the subagent type, or pass `model`
  yourself; a call that names no model gets a one-line nudge.
- Pick a model for each one. Use the smallest for searching and reading, the middle one for writing
  code, the largest for planning and review.
- Start them fresh, not forked. A fork drags your whole context along and pays for it again.
- Do not spawn for coupled work (each part needs the others' results), for small changes, or for
  back-and-forth where you would wait on the answer anyway. Do it yourself.
- Parallel subagents are one step with a count (`--progress 2/6`). They run no relo commands; you
  report for them.

## Context

- Past about 60% of your context (a prompt-time line tells you when the owner's status line shows it),
  do not compact. Run `relo work handoff --next "…"`
  (it is refused on a delivered round, so do not deliver first) and continue in a fresh session with `relo work start --from <handle>`.
- The open work, its round and the next step live in Relo. `relo state` brings them back at any time.
