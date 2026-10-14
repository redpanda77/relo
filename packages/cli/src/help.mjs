
export const GUIDE = `Relo puts your work on the owner's iPhone: one open work per session, shown while it matters.

  relo work start --goal "Fix the login crash" --plan "Reproduce the crash,Find the cause,Choose the fix"
  relo work update --status "Reproduced on iOS 17" --next-step
  relo work update --add "Patch token refresh,Run the tests"     # the plan grows in place
  relo ask "Deploy to production?" --approval
  relo work finish --outcome "Login fixed: token refresh patched and tested"   (--failed | --dropped)
  relo state                                                     # what this session has open
Steps are milestones in order. Parallel work (subagents, several jobs) is one step with a count: --progress 2/6.
A counted job without a plan: --progress 3/10. --plan "…" lists what is left (done steps stay; left-out steps
are skipped); --step "…" jumps; update applies --next-step, --plan, --add, --step, --progress, then text.
A repeat start continues the open work; another goal: start --new (the old one is parked: relo work resume).
Waiting on CI or a review: --waiting "CI". Away: relo work pause --status "…". Every command prints the plan,
what the owner sees and the exact next command; a refusal is three lines (Refused / State / Next).
No session id (Gemini CLI, Cursor, OpenCode): pass the handle start prints as --work <handle>.
ask also takes --yes-no. In a session it waits up to 100s: exit 4 means still open (relo interaction wait ID).
The finish outcome is the notification; relo notify only when no work is open.

Output is one compact JSON line (--full for the whole server reply). Errors print once, with a hint.
Exit: 0 ok/approved/yes/chosen · 5 denied/no · 4 still open (resume) · 8 closed, no answer (do not act)
      2 usage · 3 auth (relo auth login) · 1 server · 6 network · 7 no phone got it
relo doctor: ready? (follow next.run) · relo auth login (agents: prints the link, then relo auth login --wait) · relo test (once)
relo skill install --agent <claude-code|codex|opencode|gemini|amp|cursor|copilot> · relo skill status (owner's choice)
relo keys status: end-to-end encryption is automatic · a new phone waits: relo keys approve PHONE (a person), or approve it on your trusted iPhone → Settings → Devices
relo update [--check] [--rollback]: new CLI release (owner's choice; doctor warns "update":"behind")
relo setup: owner's choice, never automatic (--hooks: session hooks; --mcp: MCP server entry for shell-less harnesses) · relo sessions · --dry-run checks a command without sending · relo help identity · relo help all (every flag) · relo schema [COMMAND] (JSON)`;

export const IDENTITY_HELP = `Work identity: source > project > topic, plus where it ran: computer and account

The first non-empty value wins:
  1. Flags: --source, --project, --topic (--thread-name is an alias), --computer, --account
  2. --stdin JSON: context.providerName, project, threadName, computer, account
  3. Environment: RELO_SOURCE, RELO_PROJECT, RELO_TOPIC, RELO_COMPUTER, RELO_ACCOUNT
  4. Detection: source from the calling agent (Claude Code, Codex, OpenCode, Gemini CLI, Cursor; any other
     harness sets RELO_SOURCE); project from the git
     repository; computer from the Mac's name (scutil) or the hostname; account from "relo account NAME",
     else the name of a custom CLAUDE_CONFIG_DIR / CODEX_HOME folder (~/.claude-work -> "work").
     Nothing in an agent's config folder is ever read, only its name.

The topic is never guessed: name the work as the owner would ("Release 0.7.55", "Homepage redesign"),
not a step ("Running tests"). Generic values ("Project", "Task", "Unknown") are rejected.
Computer and account are optional context: omitted when nothing identifies them.

Cards: inside a session (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID; RELO_SESSION=<stable id> only outside a detected
harness; nested harness ids count as none) the card belongs to the session, so every command updates the same card even if the topic wording changes. Elsewhere the
card is source > project > topic. --name pins an explicit card name.

Missing fields fail before any request (exit 2); the hint is a command with only the missing flags.
relo notify inside a session takes source, project and topic from the session's card when it is running.`;

export const HELP = `Relo: full reference (short version: relo help)

The work: one open work per session (agents, and scripts with --producer KEY)
  relo work start --goal TEXT [--plan "A,B,C"] [--progress n/m] [--status TEXT] [--new] [--dry-run]
  relo work update [--status T] [--goal T] [--next-step | --step X] [--plan "A,B"] [--add "C"] [--progress n/m]
                   [--waiting TEXT | --not-waiting] [--dry-run]
  relo work pause --status TEXT · relo work resume [wrk_…] · relo work finish --outcome TEXT [--failed|--dropped] [--work wrk_…]
  relo state [--sync]     What this session has open, parked and still queued (local copy; --sync asks the server).
      The CLI identifies the session from the harness and scopes every command to it; a session never sees another's.
      Subagents run no relo commands. A change that cannot reach the server is kept ("Queued: sends with the next
      relo command") and goes out first with the next relo command. Scripts: --producer KEY (or RELO_SESSION=KEY),
      --idempotency-key on start and ask, relo work heartbeat --lease 15m. The schema has every flag: relo schema work.

Legacy Live Activity cards: scripts outside an agent session only (an agent gets a refusal that names the relo work command)
  relo activity start --title TITLE --status TEXT [--topic NAME] [--detail TEXT]
                      [--progress 0.4|40%|2/5 [--progress-label TEXT]] [--steps "A,B,C"|--step A --step B ...] [--step-current N|NAME]
      Steps vs progress: judgment work -> --steps (3-6 named phases, --next-step); script or counted job ->
      --progress DONE/TOTAL (label "DONE of TOTAL" is automatic). Never both on one card; never guess from time.
      Step names say what happens ("Run migrations"): "Step 2", "todo", "misc", "next" and repeats are refused.
                      [--symbol terminal|code|build|success|warning] [--style standard|ring|hero|terminal|steps]
                      [--privacy standard|private] [--expires-in 8h] [--stale-after 20m] [--replace]
                      [--name NAME] [--device ID...] [--idempotency-key KEY] [--stdin]
      Starts this work's card, once per goal. While it runs, a start changes nothing and continues it,
      printing the card and the commands that move it on. --step-current defaults to 1.
  relo activity update [CARD] [--title T] [--status T] [--detail T|--clear-detail] [--progress 0.4|40%|2/5|--clear-progress]
                       [--progress-label T] [--steps ...] [--step-current N|NAME | --next-step]
                       [--symbol ...] [--style ...] [--stale-after 20m] [--if-sequence N] [--idempotency-key KEY]
      --step-current takes a number from 1 or a step name; --next-step moves the card on one step.
  relo activity end [CARD] [--status T] [--detail T] [--progress 0.4|40%|2/5] [--symbol ...] [--dismiss-after 5m]
                    [--if-sequence N] [--idempotency-key KEY]      Default status "Complete", success icon.
  relo activity status [CARD] · relo activity get [CARD] · relo activity list [--limit 1..100]  (newest 10 by default)
  A card with steps draws its progress from them: --progress is ignored there (the reply says so); move it
  with --next-step or --step-current. --steps with --progress in one start is refused.
  A bare --progress above 1 is ambiguous and rejected. Title, status, detail and progress label that are too
  long are shortened at a word boundary with "…", and the reply says so in "note". Questions are never shortened.
  relo activity diagnose [CARD] [--wait [--timeout 30s]]
  CARD is a card ID or --name; leave it out for this work's card.
  --dry-run (activity start|update|end, ask, notify): validate everything locally (identity, limits, steps vs progress)
      and print {"ok":true,"dryRun":true,"would":{"command","body"},"note"?} with no request and no login needed.
      update --next-step/--step-current cannot read the card in a dry run; the note says the step resolution is skipped.

Questions: on this session's open work, with answer buttons
  relo ask QUESTION (--approval|--yes-no|--option LABEL ×2-4) [--detail TEXT] [--topic NAME] [--expires-in 5m] [--timeout 100s|--no-wait]
           [--primary-label L] [--secondary-label L] [--correlation-id ID]
           [--callback-url URL --callback-token-file PATH] [--name NAME] [--idempotency-key KEY]
      The question waits 5m by default; --expires-in asks for longer, up to the server's limit (7 days
      unless the admin changed it). Past 8h the card ends and the question keeps waiting in Relo. The
      command waits up to 5m, or 100s inside a session (your shell tool would kill it sooner). Exit 0 approved/yes/chosen, 5 denied/no, 4 still open: run
      relo interaction wait ID, 8 closed without an answer (expired, canceled): do not act. A question never starts
      a card: with none running it goes out as a notification with the answer buttons, and answering never ends one.
      QUESTION is the decision in one line of at most 120 characters: the card and its buttons show it.
      --detail carries the rest (why, risk, what changes): markdown up to 4,000 characters, read in Relo.
      --option offers 2-4 answers instead of Approve/Deny (LABEL or ID=LABEL, up to 24 characters each). The
      reply is {"state":"chosen","option":"ID","label":"LABEL"}, exit 0. Every phone it reaches needs a current
      Relo build; otherwise it is refused with choice_unsupported and nothing is asked.
      --notification-only asks with a notification that carries the answer buttons and takes no card. A login
      the owner limited to N open cards (Dashboard > Connections) does this on its own once the limit is reached.
  relo interaction get ID · relo interaction wait ID [--timeout 60s; 100s in a session] · relo interaction cancel ID
  relo listen [--since CURSOR|TIME] [--once] [--timeout DURATION]
      Every answer to this login's questions as one JSON line each, over one connection the app opens (no
      inbound port needed). Each line has a cursor; --since CURSOR resumes after a restart. Answers can
      also arrive by --callback-url (signed: Relo-Signature, Relo-Delivery-Id) or by relo interaction wait ID.

Notifications: sparingly, for finished outcomes
  relo notify [BODY...] [--title T] [--summary T] [--markdown|--format text|markdown] [--image URL] [--url URL]
              [--topic NAME] [--device ID...] [--idempotency-key KEY] [--stdin]
  relo notify withdraw ID
  In a session the topic comes from the session's card when it is running.

Identity (notify, ask, activity start): --source NAME --project NAME --topic NAME --computer NAME --account NAME.
  Source, project, computer and account are automatic; the topic is yours. See relo help identity.
  Any agent harness: Claude Code, Codex, OpenCode, Gemini CLI and Cursor are detected; others set RELO_SOURCE="<harness>"
  and RELO_SESSION=<stable id> (one card per session; questions wait up to 100s) or reuse the same --topic.
  relo account [NAME] [--clear]      Nickname for this agent account (any harness) (stored in the Relo config); no NAME shows it.

Sign-in and phones
  relo auth login [--api-url URL] [--client-name NAME] [--scope SCOPE] [--expires-in 90d] [--open]
      --client-name defaults to this computer's name. The server replaces a login of the same name,
      so two machines both called "Relo CLI" would sign each other out.
  relo auth login --profile NAME · relo auth switch NAME · RELO_PROFILE=NAME: several sign-ins (e.g. two servers or
      accounts) in the one config file. Every command uses the active profile; RELO_TOKEN/RELO_API_URL still win.
      auth status shows "profile". The phone test is per profile. Existing single-login configs read as "default".
  relo auth status · relo auth logout (the active profile only) · relo doctor [--smoke] · relo devices list
      doctor prints {"ok":true} or only the failing checks; auth status, devices list and activity list are
      compact too. --full prints everything.
  relo services create --title T [--image URL] [--url URL] [--secret-file PATH] · relo services list
      services list prints id, title, prefix and createdAt per service; --full prints everything.
  relo schema [COMMAND...]   Every command and flag as one JSON object; "relo schema activity update" (or
      activity.update) prints just those commands plus the exit codes.
  relo auth login [--no-wait|--wait]  In an agent context (or --no-wait) it prints {"state":"pending","url","code","next"}
      and exits 0: give the owner the url, then run relo auth login --wait (up to 100s; exit 4 "pending": run it again).
  relo doctor            {"ok","ready","next":{"step":"login|phone|test|skill","run","why"}}: cheap; run next.run. Writes only the 24h update-check cache.
  relo test [--again]    Once: a short card asks "Can you see this card on your iPhone?" (Yes/No). Yes records the phone.
  relo setup (--project | --global --agent claude-code|codex|gemini|opencode|copilot|amp | --file PATH) [--move] [--dry-run]
  relo setup --remove
      Owner's choice, never automatic: writes a short block between <!-- relo:start --> and <!-- relo:end --> into
      exactly ONE file (bare setup writes nothing). --project: the repo root's AGENTS.md or CLAUDE.md (whichever
      exists; both is an error, neither creates AGENTS.md). If the block is already in another file, setup refuses;
      --move relocates it. --remove deletes it wherever it is. A line <!-- relo:keep --> inside the block freezes it.
      Result: {"ok":true,"file":"~/...","action":"created|appended|updated|unchanged|kept|moved|removed","from"?}.
      Also reports whether the relo-notifications skill is installed and current (it never installs it).
  relo skill install (--agent claude-code|codex|opencode|gemini|amp|cursor|copilot|agents | --dir PATH) [--dry-run]
  relo skill status · relo skill remove (--agent NAME | --dir PATH)
      Owner's choice, never automatic. Copies the relo-notifications skill bundled with this CLI into that ONE
      harness's skills directory (--dir PATH: PATH/relo-notifications). The previous copy is moved to
      ~/.local/share/relo/skill-archives/<time>-<version>/ first. Result:
      {"ok":true,"agent","dir":"~/...","version","action":"installed|updated|unchanged","archived"?}.
      status: {"ok":true,"cli","copies":[{"dir","version","current"}]}. doctor's skill step names the exact command.
  relo update [--check] [--rollback] [--version X] [--dry-run]
      Owner's choice, never automatic; an agent runs it only after the owner agrees, never mid-task. Reads the latest
      GitHub release of redpanda77/relo (tag cli-v<version>; RELO_RELEASES_URL overrides the API base), verifies
      relo-cli-<version>.tgz against SHA256SUMS, stores it in ~/.local/share/relo/cli-releases/<version>/ and runs
      npm install --global on it. The version it replaces is stored too, so --rollback can restore it.
      --check: {"ok":true,"current","latest","updateAvailable"} and installs nothing. Success:
      {"ok":true,"from","to","verified":true}. Already latest: {"ok":true,"current","latest","updateAvailable":false}.
      A checksum mismatch installs nothing. doctor shows "warnings":{"update":{"state":"behind","latest","hint":"relo update"}}
      (checked once per 24h with a 2s timeout, cached in ~/.local/share/relo/update-check.json, off with
      RELO_NO_UPDATE_CHECK=1); it never changes ready.
  relo setup --mcp --agent claude-code|claude-desktop|cursor|codex|gemini|vscode (--global|--project) [--move] [--dry-run] · relo setup --mcp --remove
      Owner's choice: Relo's MCP server (relo mcp) in ONE harness config; same one-place rule, idempotent, --remove deletes only that entry.
  relo setup (--project | --global --agent claude-code|gemini) --hooks off|reminders|presence [--move] [--dry-run] · relo setup --hooks off · relo hooks status · relo hooks off
      Optional, off by default. Without hooks Relo works fully. The level is required. reminders (Claude Code): local only, sends
      nothing; a Stop reminder of an open or unrefreshed work and a restore of what the session was doing. presence: adds the
      session's phase for the owner's Sessions view: a local state machine reduces hook events to phases and only changes
      (plus a heartbeat every 5 minutes while working) are queued in a durable outbox and sent with a harness credential that
      can write presence and nothing else. Hooks never start, change or end a work, plan or question. Nothing installs them but
      this command; doctor never suggests them. One marked entry per event in ONE settings file (~/.claude/settings.json or
      <repo>/.claude/settings.json; Gemini CLI: ~/.gemini/settings.json or <repo>/.gemini/settings.json), each running
      "relo hook ROLE". Entries are recognised by that command, so setup is idempotent and off deletes only Relo's, and
      revokes this computer's harness credential. "relo hook" never sends prompts, tool names, tool input/output or transcript
      paths; it prints nothing, exits 0 always, and RELO_DEBUG=1 logs its errors to a file.
      Result: {"ok":true,"file","action":"created|updated|unchanged|moved|removed","level",…}.
  relo sessions [--live]  The owner's Sessions view from hooks (empty without them; refused inside an agent session):
      {"ok":true,"sessions":[{harness,computer,account,project,phase,waitingFor,presence,lastSeenAt,card}],"counts":{working,waiting,idle,ended}}
      phase: working (mid-turn) | waiting (permission/input prompt, or a turn that ended in the last 5 min) | idle (open,
      nothing new) | ended | lost. --live lists only working and waiting; counts cover every phase. Subagents share their
      session. presence: working | quiet (card silent) | no_card | ended | lost.
  Advanced: delivery reconcile, evidence timeline|metrics, outbox status|flush (what is queued for the server).

Links (--url): https:// pages, an app scheme (your-app://incidents/42) or shortcuts://run-shortcut?name=...
  http:, javascript:, data:, file:, blob: and about: are rejected. Images (--image): public https://.

Cards on the phone: only a start alerts; a question landing on a card alerts again; other updates are
  silent. iOS shows about five cards: the oldest idle one ends when a sixth starts. A card that stops
  updating goes stale after --stale-after (20m) and ends 10 minutes later. If the phone cannot show a
  question's card, the owner gets one notification saying to answer in Relo. --style ring draws progress
  as a gauge. --privacy private shows only "Private activity" and cannot carry questions.

Callbacks (--callback-url): Relo POSTs the answer with "Authorization: Bearer <token>", retried after
  30s, 2m, 10m and 1h. Expired or canceled questions never call back.

Limits: 60 writes a minute per login, 300 per account; a 429 carries retryAfterSeconds. A write (it has an
  idempotency key) that gets a 429 with retryAfterSeconds of 10 or less is retried once after that wait; anything
  longer, and any wait for an answer, returns the error with its hint.
  CI and containers: RELO_TOKEN and RELO_API_URL override the config file.

Output: one compact JSON line, e.g. {"ok":true,"id":"act_...","state":"active","sequence":3,"step":"2/5"}.
  Errors print once: JSON on stdout when piped or with --json, plain text on stderr at a terminal.
Global options:
  --json      Force JSON output and errors (automatic when piped)
  --full      Print the whole server reply instead of the compact line
  --help      Show help          --version   Show the CLI version

Exit codes:
  0 success/approved/yes   1 API/other failure   2 usage
  3 authentication/scope   4 still open (resume)     5 denied/no
  6 network                7 no accepted device  8 closed without an answer (expired/canceled)

Supplied idempotency keys use 1-200 characters from A-Z, a-z, 0-9, ., _, :, and -.
Credentials come from the mode-0600 config file (relo auth login) or RELO_TOKEN. Token flags are forbidden.`;
