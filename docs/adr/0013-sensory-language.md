# ADR 0013: one sensory language (sound, motion, haptics) across the Mac app, the iPhone app and the Dashboard

Status: accepted, 19 October 2026. Amended by [ADR 0015](0015-spoken-message-frame.md) (22 October 2026): Relo
for Mac's spoken line follows its cue, in a fixed frame and one line at a time. Amended 22 October 2026: a tech
sound set with no bells, picked from the Notch Sound Bench; start, step, expand/collapse and launch/quit cues on the
Mac; a voice mode (sound only, sound then voice, sound as the kind, voice only).

## Context

Relo shows the same moments on three surfaces: Relo for Mac (the notch and its window), the iPhone app (with its
notifications and Live Activities) and the Dashboard. An audit of each (October 2026) found:

- **Sound:**
  - Mac: five macOS system sounds, playing only while the closed notch's view is mounted, so an open question
    chimes again whenever the notch closes.
  - iPhone: the system default for every push, a finished card and a question alike.
  - Dashboard: none.
- **Motion:**
  - Dashboard: one documented token system with thorough Reduce Motion support.
  - Mac and iPhone: about a dozen and about thirty unrelated springs and curves for the same gestures, with Reduce
    Motion half honoured.
- **Haptics:** five or six iPhone calls on two APIs and no shared scale. Failure, done and pairing carry none.
- **Attention:** the same fact is told several times (iPhone: banner, sound, haptic, ripple and card for one question;
  offline four times), while the moments that matter most to the owner carry nothing: answer accepted, a computer
  paired, a failure as distinct from a done.

## Decision

### 1. Moments, not events, carry the senses

One table of owner-meaningful moments. Every surface maps its own events onto it:
- Mac: `NotchEvent`.
- Dashboard: `now-events` kinds.
- iPhone: the director's events and push categories.

A moment not in the table is silent and gets motion only.

| Moment | Sound | Haptic (iPhone) | Motion |
|---|---|---|---|
| **Needs you**: a question or approval arrives | `needs-you`, Relo's signature | medium impact | the card arrives (snappy) and the mark beats twice |
| **Failed**: work stopped on an error | `failed`, low and short | error | the tone crossfades to red (base), the card holds |
| **Your turn**: a session stopped, waiting on the owner | `your-turn`, the gentlest ping | light impact | the mark settles to coral |
| **Done**: work finished | `done`, a soft resolve | success, light | the tone crossfades to mint, then a check draws (bouncy) |
| **Sent**: the owner's answer was accepted | `sent`, a quiet tap | success | the check springs in (bouncy), the card holds 1.2 s, then settles away (smooth) |
| **Linked**: signed in, a computer paired, a browser or device linked | `linked`, the brand bloom | success | the ceremony, on one clock |
| **Turn**: an onboarding page turns (Mac, first run only) | `turn`, a soft swish | none | the page cascades in (stagger) |
| **Open/close**: the notch opens or closes on a hover or click (Mac only) | `open`/`close`, barely there; *interface sounds* setting | none | snappy |
| **Expand/collapse**: the owner unfolds or folds a card in the notch (Mac only) | `expand`/`collapse`; *interface sounds* | none | snappy |
| **Started**: work starts or moves again (Mac only) | `start`, a faint rising tick; never spoken | none | the card arrives |
| **Step**: a working card finishes a plan step (Mac only) | `update`, one faint blip, at most one per card every 3 min, never over another cue or the voice | none | the plan bar moves |
| **Launch/quit**: the owner opens Relo for Mac from the Dock or Finder, or quits it (not at login) | `launch`/`quit`, a synth in a deep hall; *interface sounds*; quitting waits for it (at most 2 s) | none | none |

Silent everywhere:
- status text (on the Mac a finished plan step ticks; elsewhere step advances are silent);
- a card starting, except on the Mac;
- dropped, paused, quiet or stale states;
- sync and refresh;
- navigation, tabs, folds, sheets and scrolling;
- offline (shown once, visually);
- back online;
- sign-out;
- anything replayed on launch or on returning to a tab (the first observation is the baseline).

### 2. Rules that keep it from being too much

- **One cue per batch.** The highest moment wins: needs you, failed, your turn, done. At most one cue every 2 s per
  surface.
- **Once per moment.** A moment is cued when it first appears, keyed by its id. A question that is still open is never
  cued again: not on a remount, not on reconnect, not on another surface's catch-up.
- **The owner acting is not news.** No sound for a moment the owner is looking at, or caused (their own answer
  gets `sent`, not `needs-you`).
- **One channel per moment.**
  - iPhone in the foreground: when the card is on screen, the in-app cue replaces the banner and its sound.
  - Lock Screen and background: the push's own sound carries it, with the same file.
- **The voice follows its cue** (Relo for Mac, ADR 0015): it starts after the cue ends, as "<Kind>: <name>.
  <gist>" with kind `Needs you`, `Failed`, `Your turn` or `Finished`; one line at a time, never interrupting; two
  lines per burst, then "And N more updates."; the cue throttle never drops speech.
- **The owner's quiet wins:** the iPhone's silent switch, Focus and Do Not Disturb, Relo's own *pause alerts*, a
  full-screen app on the Mac, and a hidden browser tab.

### 3. The sound set

Modern, tech sounds made to [Relo's sound language](../SOUND.md): no bells, nothing high-pitched, no risers or data
bursts. The owner approves every sound on the
Notch Sound Bench before it ships. The notch and its cards use mirrored pairs (one material; opening rises, closing
falls). Every cue is composed from [earshot](https://github.com/Leonxlnx/earshot)'s bank (MIT,
pure DSP, pinned to the commit the launch film uses) by `scripts/sounds/library.py`, which builds the Notch Sound Bench:
twelve moments in five kits (Pulse, Glass, Servo, Data, Flux) sharing one grammar (rising opens, falling closes, a fifth
up lands done, low and falling fails, two equal hits are your turn, three high-low-high are needs you), plus three
launch and three quit synths. Codes are `MOMENT-KIT` (`ASK-F`). Loudness is set by tier: alert −21 LUFS, status −23 to
−25, ambient −27 to −28, interface −30 to −32. `scripts/sounds/render.sh` maps each cue to its pick, checks it with
`earshot sfx check` and writes:
- `.caf` in the Mac app (the `Sounds` folder is a resource of the app target);
- `.caf` in the iPhone app for the six shared cues, named by the server in each push's `sound`;
- `.m4a` in the Dashboard for the same six.

The voice is never rendered: Relo for Mac says each line live with its own TTS.

| Cue | Pick | Character |
|---|---|---|
| `needs-you` | `ASK-05` Halo · B E B E | four soft tones, B and E alternating: the one sound that may interrupt |
| `failed` | `ERR-13` Press · G# E | a deep soft press falling a third |
| `your-turn` | `TRN-16` Felt · B B | two equal felt-mallet notes |
| `done` | `DON-H` Settle | E, G sharp, B landing on a held E chord |
| `sent` | `ACK-S` Clack | one keyboard thock |
| `linked` | `LNK-O` Dock | a warm pad stab, an answer, then the chord blooms open |
| `start` | `STR-06` Press · E B | two deep soft presses rising a fifth |
| `update` | `UPD-P` Blink | one faint blip |
| `open`/`close` | pair `NCH-B` Hush | a soft tap over a deep pop, rising A to E to open, falling to close |
| `expand`/`collapse` | pair `CRD-B` Press | one deep pop, a little higher to expand, a little lower to collapse |
| `tab` | `TAB-11` Press · B | one deep soft press, a notch tab changing |
| `section` | `SEC-11` Press · B | the same press, quieter: a Settings section changing |
| `on`/`off` | pair `TGL-02` Felt · fourth | two quick felt notes rising for on, falling for off: every switch in Settings |
| `launch`/`quit` | `LCH-01` / `QUT-01` Bloom | a warm chord opening in a deep soft hall / the chord closing |
| `turn` | `fit/whoosh.short/bamboo_swish` | onboarding only |

### 4. Defaults per surface

- **Mac:** sounds on, every cue at one volume (the files carry their tiers, docs/SOUND.md). *Interface sounds* (open,
  close, expand, collapse, tab, section, switches, turn, launch, quit) are on; the Settings window opening is silent. Voice mode: sound only (the owner's choice); the card's play button still speaks. Cues come from the
  store, not a view, so they play whatever the notch shows.
- **iPhone:** pushes carry the matching cue. In-app cues play only in the foreground, on the ambient audio session
  (the silent switch mutes them), and replace the banner when the card is visible.
  The cues ship as asset-catalog data sets; each launch copies them to `Library/Sounds`, where iOS looks for a
  push's `aps.sound`. In the foreground, a question push with Now on screen presents without banner or sound.
- **Dashboard:** sound is off until the owner turns it on in Settings, with a *Test* button. That first gesture
  unlocks Web Audio. Cues play only in a visible tab; the choice is kept per browser. The tab title carries the live
  needs-you count, and a favicon shows a dot while something needs you.

### 5. One motion vocabulary

The Dashboard's tokens are the reference. The Swift apps get the same values (`ReloMotion` in each). No literal
spring or duration outside it.

**Durations:** micro 0.12 s, fast 0.18 s, base 0.26 s, slow 0.42 s.

**Springs** (Apple's response and damping):

| Spring | Response | Damping | For |
|---|---|---|---|
| press | 0.18 | 1.0 | touch release (scale 0.97) |
| snappy | 0.28 | 0.86 | things that move: the notch, cards, indicators, sheets |
| smooth | 0.35 | 1.0 | larger travel and settling away |
| bouncy | 0.42 | 0.72 | success only (a check, linked), never lists |

**Entrances:** opacity with a 6 to 16 pt rise. Lists stagger 40 ms, capped at six. Exits run at about 0.7 of their
entrance.

**Tone changes** crossfade over `base`. The state mark never snaps.

**Living things** breathe on one shared period, 4 s. One live mark per surface.

**Reduce Motion** turns every spring into a short fade and stops the loops. Moments keep their sound and haptic: the
owner still needs to know.

### 6. Brand presence

The orb is Relo's visual on every surface:
- iPhone: the plasma orb.
- Dashboard: the WebGL orb.
- Mac: the same plasma shader in its window and onboarding.

Status marks are its flat cousin. Sign-in lives in Relo's window and onboarding, not in the notch. The server address
appears only when no install provided one, under *Use another server*.

### 7. One card anatomy, layouts that fit the space

The iPhone's work card is the reference everywhere (`ReloWorkCard`, `ReloCardTokens`, `ReloStateStyle`).

**The card:**
- The origin line, with the state's badge on its right. The state appears once and is never repeated below.
- The title, then the status.
- The plan bar, dropped when the plan is complete or the work has no steps, with a caption for the plan only.
- A footer: facts and the computer on the left, the time or the actions on the right. Answer buttons sit on the footer
  row.

**Cards are for work and questions.** Everything else is a line or a grouped row:
- "Since you looked" is a plain line.
- Finished work is a compact row.
- Sessions are rows grouped by computer, at the bottom.
- Folds are one line.

**Relo for Mac:**
- **The open notch (578 pt of content):** one column, no rail.
  - A status line: the recap, plus a lock capsule when private work waits for this Mac's approval.
  - Needs-you cards span the width.
  - Your-turn and running cards sit two per row (283 pt, the iPhone SE's card width).
  - Then finished rows and sessions.
- **The closed notch's expanded card:** the same anatomy, answerable in place.
- **Relo's window:** mirrors the iPhone's Now. A hero column (the orb, the counts, the sync line, sessions), and the
  same sections and cards on the right, answerable inline.
- **Tokens:** the Mac mirrors the iPhone's values (named the same) until a shared SwiftUI target carries them for both
  apps.

## Consequences

- Each surface keeps its own event detection and gains one mapping table onto these moments, plus a guard that cues a
  moment once by id.
- Sound files are build artifacts of one script. A new cue starts here, in this table, before it reaches any app.
- The server names a sound per push category, so the Lock Screen and the app agree.
