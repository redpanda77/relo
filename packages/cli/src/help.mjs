
export const GUIDE = `Relo shows the owner a live view of your work on their iPhone.

Two tools, one rule: if it is still happening or waiting on the owner, it is a card.
  Live Activity card   The default. One card per agent session, updated as the work moves,
                       carrying any question you need answered. Ended when the work ends.
  Notification         Sparingly: a finished outcome worth a buzz (shipped, failed, blocked).
                       Never a question, never progress.

Keep the card current
  relo activity start --title "Deploying 0.7.57" --status "Building image" --progress 0.2 --topic "Release 0.7.57"
  relo activity update --status "Pushing image" --progress 0.7
  relo activity end --status "Live on production"

Ask on the card (answer buttons on the card; waits up to 5 minutes for the answer)
  relo ask "Deploy 0.7.57 to production?" --approval --topic "Release 0.7.57"
  relo ask "Run the database migration now?" --yes-no --topic "Release 0.7.57"

Tell the owner the work is done (only when it is worth interrupting them)
  relo notify "0.7.57 is live on production" --title "Deployed" --topic "Release 0.7.57"

Which card? Every command from the same Claude Code or Codex session lands on that session's card,
so start, update, ask and end never create a second one. Outside an agent session the card is
source › project › topic: reuse the same --topic.

Identity: --source (auto: Claude Code, Codex, OpenCode) › --project (auto: git repository)
› --topic (always yours: name the work the way the owner would). See relo help identity.

Answers: exit 0 approved/yes · 5 denied/no · 4 no answer within 5 minutes (the card ends: do not act).
Other exits: 1 server · 2 usage (read the hint) · 3 auth (relo auth login) · 6 network · 7 no phone got it.
Every command prints one JSON object. Health check: relo doctor

More: relo help all (every command and flag) · relo schema (the same as JSON, for tools)`;

export const IDENTITY_HELP = `Work identity: source › project › topic

The first non-empty value wins, in this order:
  1. Flags: --source, --project, --topic (--thread-name is an alias for --topic)
  2. --stdin JSON: context.providerName, context.project, context.threadName
  3. Environment: RELO_SOURCE, RELO_PROJECT, RELO_TOPIC
  4. Detection: the source from the calling agent (Claude Code, Codex, OpenCode) and the project
     from the git repository that contains the working directory

The topic is never guessed: only the caller knows what the work is about. Name it the way the
owner would ("Release 0.7.55", "Homepage redesign"), not after a step ("Running tests").
Values that identify nothing ("Project", "Task", "Topic", "Codex task", "Unknown") are rejected.

Cards: inside a Claude Code (CLAUDE_CODE_SESSION_ID) or Codex (CODEX_THREAD_ID) session the card
belongs to the session, so every command updates the same card even if the topic wording changes.
Elsewhere the card is the combination source › project › topic. --name pins an explicit card name.

When anything is missing the command fails before contacting the server (exit 2), lists every
missing field once, and prints a hint with a corrected command. Updates, asks and ends reuse the
identity the card started with.`;

export const HELP = `Relo — full reference (start with: relo help)

Cards (Live Activities): the default for anything in progress or waiting on the owner
  relo activity start --title TITLE --status TEXT [--topic NAME] [--detail TEXT]
                      [--progress 0..1 [--progress-label TEXT]] [--step LABEL... --step-current N]
                      [--symbol terminal|code|build|success|warning] [--style standard|ring|hero|terminal|steps]
                      [--privacy standard|private] [--expires-in 8h] [--stale-after 20m] [--replace]
                      [--name NAME] [--device ID...] [--idempotency-key KEY] [--stdin]
      Starts this work's card, or updates it when it is already running.
  relo activity update [CARD] [--title TITLE] [--status TEXT] [--detail TEXT|--clear-detail]
                       [--progress 0..1|--clear-progress] [--progress-label TEXT] [--step LABEL... --step-current N]
                       [--symbol ...] [--style ...] [--stale-after 20m] [--if-sequence N] [--idempotency-key KEY]
  relo activity end [CARD] [--status TEXT] [--detail TEXT] [--progress 0..1] [--symbol ...]
                    [--dismiss-after 5m] [--if-sequence N] [--idempotency-key KEY]
      Without --status the finished card reads "Complete" with a success icon.
  relo activity status [CARD]        This work's card, if one is running
  relo activity diagnose [CARD] [--wait [--timeout 30s]]
  relo activity get CARD · relo activity list [--limit 1..100]
  CARD is a card ID or --name. Leave it out to address this work's card.

Questions: appear on this work's card with answer buttons; tappable answers only
  relo ask QUESTION (--approval|--yes-no) [--topic NAME] [--expires-in 5m] [--timeout 5m|--no-wait]
           [--primary-label LABEL] [--secondary-label LABEL] [--correlation-id ID]
           [--callback-url URL --callback-token-file PATH] [--name NAME] [--idempotency-key KEY]
      Waits for the answer by default. No card running yet? ask starts one for the question.
      Exit 0 approved/yes, 5 denied/no, 4 expired or timed out (the question stays answerable until
      it expires; resume with relo interaction wait ID). Up to 240 characters.
  relo interaction get ID · relo interaction wait ID [--timeout 60s] · relo interaction cancel ID

Notifications: sparingly, for finished outcomes
  relo notify [BODY...] [--title TITLE] [--summary TEXT] [--markdown|--format text|markdown]
              [--image URL] [--url URL] [--topic NAME] [--device ID...] [--idempotency-key KEY] [--stdin]
  relo notify withdraw ID

Account and phones
  relo auth login [--api-url URL] [--client-name NAME] [--scope SCOPE] [--expires-in 90d]
  relo auth status · relo auth logout · relo doctor [--smoke] · relo devices list
  relo services create --title TITLE [--image URL] [--url URL] [--secret-file PATH] · relo services list
  relo schema                        Every command and flag as one JSON object

Advanced (operators and debugging): delivery reconcile, evidence timeline|metrics.

Identity (notify, ask, activity start): --source NAME --project NAME --topic NAME
  Auto-detected source and project; the topic is yours. See relo help identity.

Links (--url): https:// pages and universal links, an app's own scheme (your-app://incidents/42), or
  shortcuts://run-shortcut?name=Name&input=text&text=... http:, javascript:, data:, file:, blob: and about:
  are rejected. The owner opens the link from the message; receiving a push never opens anything.
Images (--image): a public https:// image, shown with the message and as the sender's avatar.

Cards on the phone: only a start alerts; a question landing on a card alerts again; other updates are
  silent. iOS shows about five cards at once, so the oldest idle card ends when a sixth starts. A card
  that stops updating goes stale after --stale-after (20m) and ends 10 minutes later. If the phone
  cannot show a question's card, the owner gets one notification saying to answer in Relo.
  --style ring draws progress as a gauge. --privacy private shows only "Private activity": title,
  status and progress are never stored or sent, and a private card cannot carry questions.

Callbacks (--callback-url): Relo POSTs the answer with "Authorization: Bearer <token>", retried after
  30s, 2m, 10m and 1h. Expired or canceled questions never call back.

Limits: 60 writes a minute per login, 300 per account, counted per calendar minute; a 429 carries
  retryAfterSeconds. CI and containers: RELO_TOKEN and RELO_API_URL override the config file.

Global options:
  --json      Force the JSON envelope (automatic for errors when stdout is piped)
  --help      Show this help
  --version   Show the installed CLI version

Exit codes:
  0 success/approved/yes   1 API/other failure   2 usage
  3 authentication/scope   4 timeout/canceled/expired
  5 denied/no              6 network             7 no accepted device

Supplied idempotency keys use 1-200 characters from A-Z, a-z, 0-9, ., _, :, and -.
Credentials come from the mode-0600 config file (relo auth login) or RELO_TOKEN. Token flags are forbidden.`;
