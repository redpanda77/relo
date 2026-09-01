# Live Activity planning and presentation playbook

Read this reference before tracking agent work, builds, research, planning, exploration, or any
other changing workflow on the phone. Read [security.md](security.md) before sending content and
[cli.md](cli.md) for exact command grammar.

## Contents

- [Choose the workflow](#choose-the-workflow)
- [Pre-plan the activity](#pre-plan-the-activity)
- [Measure progress honestly](#measure-progress-honestly)
- [Choose presets and styles](#choose-presets-and-styles)
- [Use each semantic feature](#use-each-semantic-feature)
- [Update without visual churn](#update-without-visual-churn)
- [Track exploratory work](#track-exploratory-work)
- [Finish truthfully](#finish-truthfully)

## Choose the workflow

| Need | Smallest correct workflow |
| --- | --- |
| One future attention point | Send one ordinary notification. |
| Changing work worth following, or an explicit request to monitor/demo work | Use one Live Activity. |
| A non-permission answer blocks work | Use one yes/no or typed text interaction. |
| Permission blocks one exact action | Use one approval interaction and apply every permission gate. |
| A decision belongs inside tracked work | Attach an interaction to the exact active activity. |
| Short or silent work with no monitoring request | Do not create mobile progress. |

Any task can use a Live Activity when the user explicitly wants mobile visibility. The activity
must still communicate real lifecycle facts; the request does not authorize invented percentages,
noisy tool-call updates, or unsafe content.

## Pre-plan the activity

Before `activity ensure`, establish the following contract:

1. State one stable objective and the possible terminal outcomes.
2. Choose two to six broad outer phases that can survive normal discoveries.
3. Decide what progress measures: completed phases, completed items, bytes, tests, records, or
   another externally observable denominator.
4. Define the exact boundaries that trigger an update. Prefer phase transitions and meaningful
   milestones over elapsed time or individual commands.
5. Choose the activity identity, expected quiet interval, stale limit, expiry, and dismissal.
6. Prepare short, categorical, nonverbatim title, status, detail, step, and progress-label text.

Start before doing the tracked work. A useful five-phase agent plan is: Scope, Audit, Design,
Implement, Validate. Planning or brainstorming may be the first phase; it does not need to happen
off-screen.

Keep outer phases stable. Absorb discoveries inside the current phase. If evidence invalidates the
objective or plan, end the activity as `Replanned` without forcing 100%, then start the materially
different workflow as a new activity. Do not silently rewrite history or decrease progress.

## Measure progress honestly

- Calculate phase progress as `completed outer phases / total outer phases`. While phase 2 of 5 is
  current, progress is 20%, because one phase is complete.
- When the work already has better units, use `completed units / total units` instead. Keep the
  denominator stable and identify it in the progress label.
- Steps and progress answer different questions: steps show *where* the work is; progress shows
  *how much of a defined measurement is complete*. Supply both when both facts exist.
- A current step is not complete. Advance progress only after its exit condition passes.
- Do not use elapsed time, number of tool calls, model confidence, prose volume, or perceived effort.
- If no defensible denominator exists, use named steps without progress. An activity remains useful
  without a percentage.
- Never decrease progress. Never send 100% merely because the activity is ending.

## Choose presets and styles

Prefer omission or `automatic`; the server owns presentation composition.
Use one explicit override only when the user requests it or a stable integration contract requires
it.

| Choice | Use it when | Avoid it when |
| --- | --- | --- |
| Preset `automatic` | Normal work; let semantic facts and server policy choose presentation. | Never avoid it merely to force a layout. |
| Preset/style `standard` | A neutral status has no stronger semantic shape. | Real stages or quantitative progress deserve richer facts. |
| Preset/style `terminal` | Developer or agent work benefits from a terminal-like identity. | Do not send commands, logs, paths, or transcripts to fill it. |
| Preset/style `steps` | A small named stage sequence is the clearest representation. | Prefer repeatable `--step` facts for a real stage plan. |
| Style `hero` | One prominent milestone or attention state needs emphasis. | Routine progress updates; automatic can infer attention from safe status/symbol facts. |

`--preset` requests a named server presentation policy. `--style` is an explicit appearance
override. Do not send both during ordinary work. Repeatable steps plus optional progress
are semantic input and compile into a compositional server-driven presentation; they are preferable
to encoding a client layout.

Measured `0..1` progress always uses a compact linear bar so the percentage consumes less space on
Lock Screen and Dynamic Island surfaces. Ring progress is not part of the current contract.

Interactive styles are separate from task styles: use `approval` for conventional permission,
`shell` for a safe agent/runtime decision without raw commands, `verdict` for an explicit reviewed
outcome, and `signal` for a compact go/stop decision. They never change the permission gates.

## Use each semantic feature

| Feature | Best practice |
| --- | --- |
| Title | Keep one stable outcome-oriented title for the whole activity. |
| Status | Name the current phase or milestone in one short line. |
| Detail | Add only durable, safe context that helps; omit rapidly changing connectivity prose. |
| Steps/current | Send the complete ordered plan and a 1-based current index on each semantic step update. |
| Progress | Send only a real `0..1` measurement owned by the caller. |
| Progress label | State compact exact units such as `2 of 5 phases complete`; do not duplicate status. |
| Symbol | Use `terminal`, `code`, `build`, `success`, or `warning` only as a semantic cue. |
| Theme/accent | Omit normally so account, project, and thread policy remain authoritative. |
| Project/thread | Always supply both. Use canonical labels or bounded categorical fallbacks so server grouping, colors, and icons can differentiate work. |
| Privacy | Use standard by default; request private only when policy permits and the user requires it. |
| Stale/expiry | Set stale slightly beyond the expected quiet interval and expiry as a truthful hard ceiling. |

Private presentation does not make prohibited content safe. Appearance, color, and icon choices do
not carry lifecycle or authorization meaning.

## Update without visual churn

- Update at phase transitions, measured-unit milestones, a real waiting/blocked state, recovery, or
  terminal outcome—not after every tool call.
- Keep title and step labels stable. Keep status vocabulary bounded, such as `Phase 3 of 5 · Design`.
- Avoid cycling `Offline`, `Checking`, and `Ready` through the main text. Report a durable waiting or
  recovered transition only when it changes what the user needs to know.
- Choose appearance at start. On ordinary updates, send semantic changes only. Re-sending an
  explicit style, preset, theme, symbol, or accent asks the server to recompile appearance; when an
  appearance change is intentional, also resend every stable visible field that must survive it.
- Use one new idempotency key per changed visible operation. Reuse a key only for an identical retry.
- Let the server resolve identity, generation, sequence, monotonicity, concurrency, and downgrade.

## Track exploratory work

Exploration is trackable when its outer checkpoints are known even if its conclusions are not. A
reusable sequence is:

1. Frame questions or hypotheses.
2. Gather evidence or run bounded probes.
3. Compare options and risks.
4. Decide the plan or recommendation.
5. Implement, validate, or hand off.

Use completed checkpoints—not the number of ideas generated—as the progress denominator. Put
brainstorming inside a named phase and update when its exit condition is met. If the exploration is
truly open-ended, omit percentage until a stable plan exists while continuing to show the current
step and concise status.

## Finish truthfully

- End exactly once after the terminal fact is known.
- Use 100% only when every measured unit and the verification phase completed.
- End failures, cancellations, blocks, expiry, or replanning with their real terminal status and the
  last measured value; omission is better than a fabricated percentage.
- A successful CLI mutation proves durable server acceptance, not device display. Preserve returned
  IDs, delivery counts, sequence, and terminal state as evidence.
- Keep the five-minute CLI dismissal default when the user asked for phone-visible progress. Use a
  shorter delay only when immediate cleanup is intentional; lifecycle end and visual dismissal are
  separate facts.
