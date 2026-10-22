# ADR 0014: the line Relo for Mac says aloud, written by the producer and sealed with the card

Status: accepted, 21 October 2026. Amended by [ADR 0015](0015-spoken-message-frame.md) (22 October 2026): `--say`
is the gist inside a fixed frame, not the whole line; points 1, 2 and 5 below say how.

## Context

Relo for Mac (0.2.8) says cards aloud: a play button on every card, and updates read after their sound. The line is
composed on the Mac from the card's own words (goal, outcome, question prompt, status). Those words are written for
the eye: they may carry markdown, paths and ids, and the outcome notification is usually a terse record of what was
done. A producer that knows how its work should sound has no way to say it.

## Decision

1. **A producer may declare the spoken line.** `relo work deliver --say "…"` and `relo work finish --say "…"` carry
   it: one or two plain sentences, at most 160 characters, what happened first, no markdown, paths or ids. It is
   declared text like the goal and the outcome: the producer holds the work and writes it; the server never infers
   it and hooks never write it (ADR 0008 ownership matrix).
   *Amended by 0015:* `--say` is the gist of the line, said after the Mac's "<Kind>: <name>.", at most 12 words and
   100 characters; the CLI refuses a version, hash, id, path or link in it.
2. **It travels only inside the sealed card.** The spoken line is a field of the card's sealed text (`spoken`, beside
   `title`, `status` and `phases`), opened on the owner's devices like every other word of the card. The server holds
   no column, no wire field and no copy of it, so there is nothing to derive, migrate or leak.
   *Amended by 0015:* the CLI always seals `spoken` on deliver and finish (the outcome shortened when `--say` is
   absent), and `name` (`relo work start|update --spoken-name`) rides beside it. A readable work (an
   account without end-to-end encryption) has no sealed card: `--say` is not sent and the CLI says so in its echo.
3. **Questions and notifications get no second field.** A question's prompt is already one self-contained line of at
   most 120 characters, and `relo notify` has `--summary` (plain text, 240 characters). Both are spoken as they are.
4. **It lives as long as the card text does.** The CLI builds a card's sealed text from the work each time, so the
   next update (a new round, a status) leaves `spoken` out and the Mac speaks its composed line again.
5. **The Mac says it as it is, cleaned.** *Amended by 0015: the Mac says it as the gist of its frame.* Relo for Mac says `spoken` instead of its composed line, after the same
   cleaning (markdown, glyphs, links, paths and ids) and with the same playback rules (quiet while the microphone is
   in use, per-kind switches, paused alerts, full screen). The play button speaks it too.
6. **Producers are told.** The skill says goals, outcomes and questions are read aloud and names `--say`. Scripts do
   not take `--say` yet: a script's outcome is machine text, and a spoken line for it would be a second thing to keep
   true.

## Consequences

- No server release, no migration: the change is the CLI (flag and sealed card text), the shared sealed-card decoder
  and Relo for Mac.
- An older Mac or iPhone ignores `spoken` (unknown keys are dropped on decode); an older CLI has no `--say`.
- The iPhone app does not read it aloud; if it ever does, it reads the same field.
