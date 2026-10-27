# Check a Relo install

Use this when the owner asks you to check that Relo is set up, after Relo for Mac's onboarding or install, or when cards stop appearing. Run the commands, read every field, fix what fails, and
report in plain words what you found and what you changed. Never sign in, sign out, or change the server
yourself.

## 1. Run the doctor

```bash
relo doctor --json
```

`ready: true` means this computer can reach its Relo and show the owner cards. Read on anyway: the warnings
below can matter even when it is ready.

| Field | Good | If not |
|---|---|---|
| `checks.server` | `reachable` | The server is down or the URL is wrong. On a Mac running Relo locally: open Relo for Mac, which starts its server. Elsewhere: tell the owner the server is unreachable. |
| `checks.auth` | `authenticated` | The sign-in expired or was revoked. Tell the owner; they sign in again from Relo for Mac or with `relo auth login`. |
| `checks.runtime` | every check `ok` | `database` behind: the server is mid-update, so wait a minute and run the doctor again. `worker` stale: on a local install, quit and reopen Relo for Mac. `devices` 0: no phone and no Mac is signed in; open Relo for Mac and sign in. |
| `checks.local.server` (local installs) | `ready` | Open Relo for Mac. If it still fails, its log is in `~/Library/Application Support/Relo/server/logs`. Read the last lines and tell the owner what they say. |
| `checks.local.versionsMatch` | `true` | An update left the old server running: quit and reopen Relo for Mac. |
| `warnings.agentSetup` | every file `current` | `relo setup --refresh` rewrites Relo's parts to this version. |
| `warnings.update` | `managed` on a Relo for Mac install | Relo for Mac updates the CLI. If it says `auto` there, run `relo update --mode managed`. |

## 2. See a card

```bash
relo test
```

It sends a test card and asks the owner whether they can see it, in the notch on a Mac with no phone, or
on the iPhone. Ask the owner to answer it. A yes is the proof; the doctor alone is not.

## 3. Check the agents

`relo doctor --json` lists the files Relo wrote for each agent under `warnings.agentSetup`. For Claude Code
and OpenCode, each should be listed and `current`. An agent installed after setup isn't there:
`relo setup --agent <id>` adds it (ask the owner first). Restart an agent after its setup changed; a running
session keeps the instructions it started with.

## 4. Report

Say, in a few lines:
- whether Relo is ready, and where it runs (on this Mac, or the server's address);
- whether the owner saw the test card;
- which agents are set up;
- what you fixed, and anything the owner has to do themselves.
