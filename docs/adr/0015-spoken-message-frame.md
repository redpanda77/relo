# ADR 0015: one frame for every spoken update: kind, name, gist

Status: accepted, 22 October 2026, implemented (server 0.18.102, CLI 0.17.57, Relo for Mac 0.2.10). Revision 1
(length by urgency, the agent writes the line, a voice level) accepted and implemented the same day. Amends [ADR 0014](0014-spoken-line.md) and
[ADR 0013](0013-sensory-language.md).

## Context

Relo for Mac (0.2.9) says four kinds of update aloud after their sound: a question, a failure, your turn and a
finish. Every card's play button says its line too. `SpokenLine.text(for:prompt:)` composes the line as
"<goal> needs you. <prompt>", "<goal>: your turn. <outcome>", "<goal> finished. <outcome>" or "<goal> failed.
<status>", cleaned of markdown, glyphs, links, paths and ids and capped at 280 characters. An agent may replace the
whole line with `--say` (ADR 0014).

The owner finds the readouts too long and full of version numbers, and every line is shaped differently. A listener
who was not paying attention cannot tell what a line is about until it is half over.

### What good spoken interfaces do

- **Aviation alerting** ([FAA guidance on AC 25.1322-1](https://hfcc.dot.gov/publications/docs/GeneralGuidance/zz_FAA_GeneralGuidanceDoc_Chapter_04_Section_03.html)):
  - A distinct master tone for warning and for caution, then a short voice message.
  - Two senses for every alert; nuisance alerts are a defect.
  - Voice callouts are one to three words, always in the same wording ("TERRAIN, PULL UP").
- **ATC phraseology** ([FAA AIM 4-2](https://www.faa.gov/air_traffic/publications/aim_html/chap4_section_2.html)):
  - Fixed order: who is called, who is calling, where, then what.
  - Standard words only, so a half-heard call still parses.
  - The order matters more than the words: a listener knows which slot they are in.
- **Siri Announce Notifications** ([Apple](https://support.apple.com/102536)):
  - A tone, then "<sender> says <message>".
  - A long message is announced, not read: the sender and the fact that it arrived.
  - Only time-sensitive notifications and direct messages are announced by default.
- **Alexa voice design** ([one-breath test](https://developer.amazon.com/blogs/alexa/post/531ffdd7-acf3-43ca-9831-9c375b08afe0/things-every-alexa-skill-should-do-pass-the-one-breath-test),
  [dialog benchmarks](https://developer.amazon.com/en-US/blogs/alexa/post/d92c7822-d289-44fd-a9fe-9652874fc3c9/five-benchmarks-for-writing-dialog-that-sounds-great-to-alexa-customer)):
  - If a line cannot be said in one breath, cut it.
  - Breaths fall between ideas, never inside one.
  - Lists are split, not read.
- **Screen readers (VoiceOver, NVDA, JAWS):**
  - Verbosity levels.
  - Punctuation and attributes left unsaid.
  - The most important word first; sounds stand in for repeated words.
- **Earcons** ([Brewster's guidelines](https://www.dcs.gla.ac.uk/~stephen/earcon_guidelines.shtml)):
  - A family of sounds told apart by timbre, register and rhythm.
  - Learned meaning, so the set stays small and stable.

### What the research and other agent voice tools show (added 22 October, after the first release)

The first release took its lengths from the one-breath test alone. The owner then asked for rules grounded in published
guidance and in how other agent voice tools work. What that shows:

**Human factors: count ideas, not words, and scale them by urgency.**
- FHWA's in-vehicle guideline on [auditory message length](https://www.fhwa.dot.gov/publications/research/safety/98057/ch03b.cfm)
  counts *information units* (key nouns and adjectives):
  - an urgent message is "a single word or a short sentence with the fewest number of syllables possible";
  - a non-urgent one is "a maximum of 7 units of information in the fewest number of words possible";
  - the most important information goes first (or last);
  - the listener can have it repeated, and the same message is shown visually too.
- Air traffic control studies ([FAA 2008](https://www.faa.gov/data_research/research/med_humanfacs/oamtechreports/2000s/2008/200821),
  [FAA 2009](https://libraryonline.erau.edu/online-full-text/faa-aviation-medicine-reports/AM09-02.pdf)):
  - most controller messages carry one to three pieces of information;
  - errors stay under 1% up to five pieces and rise at six or seven;
  - longer messages raise both omissions and readback errors.
- Medical alarms ([IEC 60601-1-8 Annex E](https://standards.har-el.com/Projects/181701/60601-1-8/html/Annex-E.htm)): an
  attention burst first, then "a short spoken message identifying the alarm condition".
- Voice assistants ([CHI 2022, Haas et al., 72 participants](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.100/1-hci/hci-paper/2022/CHI2022_Keep_it_short.pdf)):
  - short responses were rated as useful and likable as full sentences, and more efficient;
  - a bare confirmation that dropped *what* was done lost trust ("It is good to acknowledge instruction so you know
    that it has gotten it right");
  - news was preferred in full sentences;
  - the authors recommend letting people choose a brief or full style.
  - Google's guidance (saying too much is "as uncooperative as saying too little") and Alexa's one-breath test agree.
- Screen readers ([Deque](https://dequeuniversity.com/tips/webpagechanges) and others):
  - polite announcements by default, interrupting ones only for the critical;
  - debounce bursts;
  - always give context.

**Agent voice tools for Claude Code and similar harnesses** (October 2026) take one of two approaches:
- **The agent writes its own line for the ear**, from an instruction it always sees:
  - [claude_voice](https://github.com/cris-m/claude_voice) injects a "TTS summary" instruction through a hook that
    survives compaction and speaks the summary at Stop;
  - [mcp-speak-when-done](https://glama.ai/mcp/servers/na1axgvmxy) has the agent call a tool with a one to three
    sentence spoken summary.
- **A second model summarizes afterwards:**
  - [claude-mlx-tts](https://github.com/aperepel/claude-mlx-tts) condenses the response to a 10 to 15 word spoken update,
    and speaks only after deep work (15 s or more, two or more tool calls, or thinking);
  - [cc-hooks](https://deepwiki.com/husniadil/cc-hooks) writes short contextual messages from the transcript, with sound
    effects and a per-session queue;
  - [claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) asks for "under 10 words", but its
    examples are content-free ("Work complete!") and its notification line is fixed ("Your agent needs your input").
    That is exactly the trust problem the CHI study found.
- [AgentVibes](https://cdn.jsdelivr.net/npm/agentvibes@5.10.1/README.md) adds a verbosity setting.

**What follows for Relo** (applied in Revision 1 below):
1. **Budget ideas by urgency.** A question or a failure is urgent: the decision or the reason, three or four
   information units, about 12 words. A finish or your-turn is news: up to seven units, about 20 words, which is where
   the agent tools cluster (10 to 15 words) at its upper end.
2. **Always say what happened, never only that something happened.** A frame without content is the
   "Work complete!" anti-pattern.
3. **The agent that did the work is the best author of the line.** Its instruction must be where every session sees
   it, not in a reference file: the first test with a fresh agent wrote good lines only because it chose to open
   `references/cards.md`. The composer stays as the fallback for agents and scripts that don't write one.
4. **Let the owner choose brief or full.**
5. **Keep what the first release already does:** speak only meaningful events, an attention cue first, a visual copy
   (the card), replay on demand (the play button), and a queue that debounces bursts.

### Principles for Relo's spoken updates

1. **The cue says the class, the voice says the case.** The sound (ADR 0013) tells the owner what kind of update it
   is before a word is spoken. The voice starts after the cue ends, never over it.
2. **Fixed slots, same order every time: kind, name, gist.** The first words are always one of a closed set of
   kind words, so a half-heard line still says whether it needs the owner. Kind goes first, not the name, as in
   aviation. Relo's channel has one listener, so ATC's callsign-first reason does not apply. Kind first also works
   with any name, including an imperative goal ("Finished: fix the film").
3. **One breath.** A line is at most 18 words, about 7 seconds at 150 words a minute; most are 8 to 12. The name
   is at most 4 words and the gist at most 12.
4. **Announce, don't read.** The gist is one idea: the first clause that says what happened. Details stay on the
   card.
5. **Never read inventory:**
   - version numbers, build numbers or commit hashes;
   - ids, codes, paths, file names or links;
   - parentheses, or lists of more than two items;
   - more than one number. A count that is the news ("3 suites failed") stays.
6. **Kinds are told apart three ways:**
   - the cue (ADR 0013);
   - the kind word in the first slot;
   - the question's own rising "?".
   A failure's gist is its reason. A question's gist is what to decide.
7. **Say less when more arrives.** One line at a time, never interrupting, most important first. A third update
   becomes a count. News that waited too long is dropped, except a question that is still open.
8. **The CLI composes, the Mac frames.** Declared text is shortened once, at the edge, where the producer sees the
   result (ADR 0008: the CLI is the edge). The Mac adds only the kind word and the name, cleans, and caps.

## Audit: what is said today

Real outcomes and question prompts from this month's sessions. The goals are real goal shapes. Hosts are
neutralised.

| Event | Said today | Words, about |
|---|---|---|
| Your turn | "Speaking support for Relo for Mac with the Phonon voice: your turn. Relo for Mac 0.2.8 is live: cards say their line aloud, the Relo voice downloads itself on Wi-Fi, and agents are told to write for the ear." | 39, 16 s |
| Your turn | "Ship the next batch of session lifecycle fixes: your turn. All live and current: server 0.18.74, CLI 0.17.45, iPhone 0.10.29 (92). Nothing uncommitted or unreleased." | 25, 10 s |
| Your turn | "Plan 12: Dashboard plan tree and optimize extras: your turn. Plan 12 shipped: Dashboard plan tree, optimize extras (status line, subagents, nudges, context and cost). Server 0.18.62, CLI 0.17.34, iOS 0.10.24." | 31, 12 s |
| Your turn | "Relo for Mac becomes Relo: signed for an easy install, a Dock app with a main window and a cool onboarding: your turn." (the outcome was cut entirely) | 23, 9 s |
| Your turn, a session's turn ended (observed) | "Propose one consistent structure for Relo for Mac's spoken updates: your turn. Replaying real cards through today's composer and drafting the principles." (a stale status) | 22, 9 s |
| Finished | "Brainstorm speaking support for the notch with the Phonon voice model finished. Voice architecture proposed: load on demand and unload after 5 idle minutes, in-process engine behind a swappable interface, full clips cached in memory, shipped in 3 stages." | 39, 16 s |
| Finished | "Find why the launch film shows a blank, frozen frame on iPhone Safari and Chrome, and fix it finished. Notification taps no longer crash the app (iPhone 0.10.26), and the encrypted-items card lines up. Live in 0.18.68." | 37, 15 s |
| Failed | "Set up Codex on the build server with Relo's instructions failed. A live run failed: its configured model gpt-5.6-sol isn't allowed with a ChatGPT login." | 23, 9 s |
| Question | "Fix the sign-in approval page on the build server needs you. Deploy server fea6d51 to the build server? It only restyles the iPhone sign-in approval page (no migrations); API restarts, rollback tag kept." | 29, 12 s |
| Question | "Let opencode on a headless server connect to the project MCP needs you. Approve the build server's Relo sign-in, code HB9H-9HKB?" | 19, 8 s |
| Question, relayed permission | "Redesign the open notch view of Relo for Mac: uniform cards, full-width list, one-line summary, motion needs you. Allow Bash: npm run public:check?" | 23, 9 s |

### Where it breaks

1. **The goal leads, and it is written for the eye.** Goals run up to 120 characters, so the line often spends 5
   seconds before saying what happened. Imperative goals read badly with a trailing verb ("…, and fix it
   finished").
2. **The kind word moves.** It sits after the goal, in three grammatical shapes ("needs you", ": your turn",
   "finished"). A listener cannot find it without hearing the whole goal.
3. **The whole outcome is read.** Outcomes run up to 200 characters and are written as a record: version
   inventories, build numbers in parentheses, lists of five features. Nothing removes versions, hashes or codes:
   `clean` keeps "0.18.99" and "fea6d51" by design (its test pins "version 0.18.99").
4. **The 280-character cap cuts at the last full stop.** When the goal and the first sentence of the outcome pass
   280 characters together, the outcome is dropped and only the goal is said.
5. **An observed "your turn" reads a stale status.** A session that stopped without a deliver has no round
   outcome, so the line falls back to the last status ("Replaying real cards…"), which is past news.
6. **A question's whole prompt is read,** with its rationale ("It only restyles…; API restarts, rollback tag
   kept") and codes meant for the eye. A relayed permission reads the command.
7. **`--say` replaces the frame.** An agent's line drops the goal and the kind word, so it is shaped unlike every
   other line. An agent's own `--say` example in the skill carries a version ("Version 0.17 is on TestFlight").
8. **Timing:**
   - The voice starts 700 ms after the cue starts. `needs-you` lasts 1.2 s and `done` 1.0 s, and Phonon starts
     speaking in about 10 ms, so the voice talks over the cue.
   - Only the lead event of a batch is said; the rest are silent.
   - An event within 2 s of the last cue gets neither cue nor voice, so it is lost to the ear entirely.
   - A new line stops the one playing mid-sentence.

## Decision

### 1. The frame: `<Kind>: <name>. <gist>`

| Event | Kind words | Gist from | No gist when |
|---|---|---|---|
| Question or approval | `Needs you` | the question's prompt | never |
| Failed | `Failed` | the finish outcome, or `--say` | the outcome is empty |
| Your turn (a deliver) | `Your turn` | the round outcome, or `--say` | — |
| Your turn (observed: the session stopped) | `Your turn` | nothing | always: the status is past news |
| Finished | `Finished` | the finish outcome, or `--say` | the outcome is empty |
| Play button, running | `Working` | the current step | no current step |
| Play button, paused or stopped | `Paused`, `Stopped` | nothing | always |

Dropped and left-unfinished work stays silent, as ADR 0013 already rules.

### 2. The name: declared once, at most four words

- `relo work start --spoken-name "<2 to 4 words>"` declares how the work is called aloud: a noun phrase ("Spoken
  updates", "Notch redesign"), at most 32 characters. Not `--name`: that flag already names a script producer when
  no session id is present, so it cannot double as the spoken name.
- It is declared text like the goal (ADR 0008). It travels only inside the sealed card, as `name` beside `title`
  and `spoken`, so the server gets no column. It lasts for the life of the work; `relo work update --spoken-name`
  changes it.
- Without one, the Mac takes the goal's head: the text before a colon or dash, at most four words, trailing
  function words dropped.
- The replay shows mechanical heads are often poor ("Let opencode", "Relo for Mac becomes"). That is why the skill asks
  for the name rather than relying on the fallback.

### 3. The gist: composed by the CLI, sealed, shown in the echo

- On `deliver` and `finish`, the CLI always seals `spoken`: the agent's `--say` if given, else the outcome
  shortened by the rules below.
- Every echo gets a line `Mac says: "<the full line>"`, so the producer hears what it wrote, the way `Owner sees:`
  shows the Lock Screen.
- Shortening rules, in order:
  1. Clean (today's `clean`).
  2. Remove version numbers: a leading one becomes "The new version".
  3. Remove build numbers, commit hashes, ids, codes, file names, links and parentheses.
  4. Remove product lists left empty ("server, CLI").
  5. Take the first sentence, then its first clause of three words or more (split at `;`, `:`, `—` and
     `, and`).
  6. Cap at 12 words, cutting at a word boundary and dropping a trailing function word.
- **`--say` becomes the gist, not the line.** The frame stays: "Finished: TestFlight release. The iPhone app is
  on TestFlight."
  - At most 12 words and 100 characters (down from 160).
  - The CLI refuses a `--say` with a version, hash, id, path or link, naming what it found, as it refuses
    placeholders today.
- **Questions:** `relo ask` stays as ADR 0014 left it, with no second field. The Mac says the prompt's first
  sentence:
  - parentheses, hashes and codes removed;
  - at most 12 words;
  - a relayed permission ("Allow Bash: …?") says the tool only ("Allow Bash?").
- **A readable work** (no sealed card) and a card from an older CLI have no `spoken`. The Mac says the frame
  alone: never long, never inventory.

### 4. The Mac: frame, clean, cap; then cue, wait, speak

- The Mac composes only the frame (kind word and name), cleans, and caps at 120 characters at a word boundary.
  It never shortens outcomes itself.
- The voice starts 250 ms after the cue ends.
- A speech queue replaces "lead event only":
  - one line at a time, most important first (question, failed, your turn, finished);
  - a line never interrupts another (the play button does: the owner asked);
  - at most two lines per burst; a third and later become one line, "And 3 more updates.";
  - a queued your-turn or finished line older than 60 s is dropped;
  - a question stays queued while it is pending; each open question and each failure gets its own line, never a count.
- The 2-second cue throttle stays for sounds only. A throttled event still joins the speech queue.
- Unchanged: quiet while the microphone is in use, per-kind switches, paused alerts and full screen.

## After: the same events

The middle column is a prototype of these rules run on the same inputs, with no name declared: the gist is
reliable, the fallback name is not. The last column is what a producer following the new skill would get.

| Event | Today | Proposed, from the outcome alone | Proposed, with name and `--say` |
|---|---|---|---|
| Your turn | 39 words, 16 s | "Your turn: Speaking support for Relo. Relo for Mac is live." | "Your turn: Spoken updates. Relo for Mac now reads cards aloud." (11 words, 4 s) |
| Your turn | 25 words, 10 s | "Your turn: Ship the next batch. All live and current." | "Your turn: Session lifecycle. Everything is live and current." (9, 4 s) |
| Your turn | 31 words, 12 s | "Your turn: Plan 12. Plan 12 shipped." | "Your turn: Plan twelve. The Dashboard plan tree is live." (10, 4 s) |
| Your turn | goal only, outcome lost | "Your turn: Relo for Mac becomes. Relo for Mac is Relo." | "Your turn: Relo for Mac. It is signed and has a main window." (13, 5 s) |
| Your turn, observed | stale status, 9 s | "Your turn: Propose one consistent structure." | "Your turn: Spoken updates." (4, 2 s) |
| Finished | 39 words, 16 s | "Finished: Brainstorm speaking support. Voice architecture proposed." | "Finished: Voice design. The voice architecture is proposed." (8, 3 s) |
| Finished | 37 words, 15 s | "Finished: Find why the launch. Notification taps no longer crash the app." | "Finished: Film on phones. Notification taps no longer crash the app." (11, 4 s) |
| Finished, `--say` | "Version 0.17 is on TestFlight." (no frame) | "Finished: Release the iPhone app. The new version is on TestFlight." | "Finished: TestFlight release. The iPhone app is on TestFlight." (9, 4 s) |
| Failed | 23 words, 9 s | "Failed: Set up Codex. A live run failed." | "Failed: Codex setup. Its model is not allowed with a ChatGPT login." (12, 5 s) |
| Failed | "Run the release gates failed. 3 suites failed." | "Failed: Run the release gates. 3 suites failed." | "Failed: Release gates. 3 suites failed." (6, 2 s) |
| Question | 29 words, 12 s | "Needs you: Fix the sign-in approval. Deploy server to the build server?" | "Needs you: Sign-in page. Deploy server to the build server?" (10, 4 s) |
| Question | code read aloud, 8 s | "Needs you: Let opencode. Approve the build server's Relo sign-in?" | "Needs you: Headless sign-in. Approve the build server's Relo sign-in?" (10, 4 s) |
| Relayed permission | the command read aloud, 9 s | "Needs you: Redesign the open notch. Allow Bash?" | "Needs you: Notch redesign. Allow Bash?" (6, 2 s) |

Today a line averages about 26 words, 10 seconds, and reaches 41 words, 16 seconds. With the frame, lines are 4 to
13 words, at most 6 seconds. Every line begins with one of seven kind words.

## What the skill tells agents

The skill's spoken paragraph in `references/cards.md` and rule 3 of `SKILL.md` would say:

- Relo for Mac says updates as `<Kind>: <name>. <gist>`. Kind is `Needs you`, `Failed`, `Your turn` or
  `Finished`.
- Give the work a name on `start`: `--spoken-name "Notch redesign"`, two to four words, a noun phrase.
- The gist is your outcome's first clause, without versions, builds, hashes, ids or paths. `deliver` and `finish`
  echo `Mac says: "…"`. If it reads badly, pass `--say`: one plain sentence, at most 12 words, no numbers but a
  count.
- The example becomes `--say "The iPhone app is on TestFlight."`, without a version.
- Questions: put the decision in the first sentence, at most 12 words, and the reasons after it.

## How it is tested

- **One golden file shared by both sides:** `packages/cli/test/fixtures/spoken-lines.json`.
  - Each case is: kind, goal, name, outcome or prompt, `--say`, and the expected gist and full line.
  - It starts with the rows of the table above. Hosts are neutral, per `public:check`.
  - The CLI's tests run the composer over it. `SpokenLineTests` reads the same file through `#filePath` and checks
    the frame and the question rules, so the JS and Swift sides cannot drift.
- **Properties over every golden and a fuzzed set of outcomes:**
  - the line starts with a kind word;
  - at most 18 words and 120 characters;
  - no `\d+\.\d+`, no hex run of seven or more, no `/`, no `(`;
  - it ends with `.` or `?`.
- **A listening check, once per change to the rules:** render the goldens with Phonon on this Mac. Each clip must
  be at most 7 seconds, and no voice may start before its cue ends (`ReloMoments` timing, unit-tested with a fake
  clock).
- **Queue tests:**
  - three events in one burst give two lines and "And 1 more update.";
  - a throttled cue still speaks;
  - a finished line older than 60 s is dropped;
  - a question is never dropped while pending, and a failure is never folded into a count.

## Changes to other ADRs

- **ADR 0014:**
  - Point 1: `--say` is the gist inside the frame, not the whole line, at most 12 words and 100 characters. The
    CLI refuses versions, hashes, ids, paths and links in it.
  - Point 2: `name` joins `spoken` in the sealed card, and `spoken` is now always sealed on deliver and finish
    (composed when `--say` is absent).
  - Point 5: the Mac says the frame with `spoken` as its gist.
  - Point 3 stands: questions get no second field.
- **ADR 0013:**
  - §2 gains the voice rules: the voice follows its cue after it ends, one line at a time, two lines per burst
    then a count. The cue throttle never drops speech.
  - §1's table gains a "Voice" column with the kind words.

## Revision 1 (accepted 22 October, implemented): length by urgency, the agent writes the line, a voice level

Grounded in the research above. It replaces the single 12-word gist.

| Kind | Gist budget | Why |
|---|---|---|
| Needs you | the decision, at most 12 words | urgent: FHWA "short sentence"; the reasons belong in `--detail` |
| Failed | the reason, at most 12 words | urgent; the reason is the news |
| Your turn, Finished | what happened and what it means, at most 20 words (about seven ideas) | non-urgent news: FHWA's 7 units; agent tools say 10 to 15 words; people prefer full sentences for news |

- **Who writes it:**
  - The agent is asked to write the spoken line on every deliver and finish: `--say`, at most 20 words (12 for a
    failure).
  - The instruction moves into SKILL.md's rules and the MCP tool descriptions, which every session reads.
  - The CLI's echo nudges an agent that skipped it: `Mac says:` plus a note when the line came from the fallback.
  - A start without `--spoken-name` gets a note naming what the Mac will call the work.
  - The composer (phrases of the first sentence, inventory dropped) stays as the fallback.
- **A voice level on both sides; the lower one wins.** The owner asked for the choice to sit in settings, verbose by
  default, and for the CLI to set it too, overridable per project, so the agent knows how to behave.
  - *Levels:* `off` (nothing), `brief` (the frame alone: "Finished: Notch redesign."), `full` (the frame and the gist),
    `verbose` (full, plus each finished plan step: "Working: Notch redesign. 3 of 5 done, now build the list.").
  - *Producer (CLI):* `relo voice LEVEL` sets this computer's default and `relo voice LEVEL --here` one repository or
    folder. `RELO_VOICE` overrides both; without any of them the level is `verbose`.
    - The level rides each card sealed (`voice`, beside `name` and `spoken`).
    - The start echo tells the agent what to write at that level. At `off` no gist is sealed and `Mac says:` reads
      "nothing".
    - `off` is the setting for a confidential project: it is never read aloud, not even by the play button.
  - *Owner (Relo for Mac):* Settings › Voice › Spoken detail, Brief, Full or Verbose (default Verbose), is the ceiling.
    A card is said at the lower of the two; a card from an older CLI counts as `full`. The play button says the full
    line unless the card is `off`.
  - *Finished steps at verbose:* only when a card's finished-step count rises, never for status text. No cue; last in
    the queue. At most one per card every three minutes, dropped after 60 s. Hooks still never speak: the count is
    the agent's declared plan.
- **Unchanged:** the frame, the kind words, the spoken name, no inventory, the cue-then-voice timing and the queue.

## Consequences

- No server change: `name` and `spoken` ride the sealed card.
- The CLI gains `--spoken-name` (start and update, plus the MCP tool), the composer, the `--say` checks and the
  `Mac says:` echo line. Relo for Mac gains the frame, the question rules and the speech queue.
- Older Macs speak `spoken` as a whole line, as ADR 0014 does today. The gist alone is short and clean, so that
  degrades gracefully. An older CLI sends no `name` or `spoken`, and the new Mac says the frame alone.
- Shortening lives in one place, the CLI. The Mac never guesses at outcomes. Scripts calling the HTTP API get the
  frame alone until a script flag is worth adding (ADR 0014 point 6 stands).
- Not covered: `relo notify` is not spoken today and stays so. A spoken digest ("while you were away") would build
  on the same frame later.
