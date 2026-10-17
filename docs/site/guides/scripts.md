---
title: Scripts, cron and CI
nav: Scripts and CI
summary: Your jobs report progress and outcomes from any script, cron entry or pipeline, and ask before a risky step.
---

## Why

A nightly backup, an import or a deploy pipeline usually runs with nobody watching. You learn it failed
the next morning, or never. With Relo the job shows its run on your iPhone while it matters, alerts you
when it fails, and can stop to ask before the step that cannot be undone. It uses the same
`relo work` commands as an agent, named by a producer key instead of a session.

## Name the job

A script has no session, so it names itself with a **producer key**: `--producer KEY` on every
command, or `RELO_SESSION=KEY` once in the environment. The key is 1 to 100 characters of letters,
digits, `.`, `_`, `:` and `-`, and it is the label you see, so pick a real name: `nightly-backup`,
`deploy-web`. A script without one is refused, with the exact command to fix it.

Each key has one open work. A second start with the same key continues it; `--new` parks it and starts
another.

## Wrap a command

The shortest way to see a job: put `relo run --` in front of it.

```sh
relo run -- ./nightly-backup.sh
relo run --goal "Back up the photo library" -- rsync -a /photos /backup
```

Relo shows the run on your phone while it goes and finishes it from how it ends: exit 0 is done
("Done in 4m 2s"), any other exit or a signal is failed and alerts you ("Failed (exit 3) after 12s"),
and Ctrl-C is dropped. The command's output and input pass through untouched, and `relo run` exits with
the command's own exit code, so a pipeline or cron still sees what the command said.

- **A crash is a failure.** You are told when it fails, not an hour later when the card goes quiet.
- **Never in the way.** Not signed in, or the server unreachable: the command runs anyway, you get one
  line on stderr, and the result is sent when the network is back.
- **Plain goal.** Without `--goal`, the card is named after the command ("Run npm").
  Its arguments and the environment are never put on it.
- Put `--` before the command so its own flags stay its own. `--plan`, `--producer` and `--lease` work
  as in `relo work start`; Relo renews the lease while the command runs.

For a job with steps you want to report, use the `relo work` commands below.

## Report a run

```sh
relo work start --producer nightly-backup --goal "Back up the photo library" \
  --plan "Snapshot,Upload,Verify" --lease 30m --idempotency-key "backup-$(date +%F)"
relo work update --producer nightly-backup --next-step --status "Uploading 12 GB"
relo work update --producer nightly-backup --next-step
relo work finish --producer nightly-backup --outcome "Backup verified: 41,200 photos, 12 GB"
```

- **Idempotency.** When stdin is not a terminal (cron, CI), `relo work start` needs
  `--idempotency-key`: a retry returns the same work instead of a second one. Derive it from the run
  (`$GITHUB_RUN_ID`, the date).
- **Counted jobs.** A job that processes items reports a count instead of, or inside, a plan:
  `relo work update --producer nightly-backup --progress 340/1200`. It is shown as "340 of 1200". A
  measured count or nothing; never a guess from time.
- **Finish once.** The outcome is your notification. Add `--failed` when it did not succeed, so you get
  an alert, or `--dropped` when the run was abandoned.

Every flag: [work reference](/docs/reference/cli/work).

## Leases and heartbeats

A card that stops updating is dimmed after {{fact card.freshSeconds}} and leaves the Lock Screen after {{fact card.retireSeconds}}. A long quiet
step (a 40-minute upload) would look stale, so the script declares a **lease**: how long it may stay
silent and still count as moving ({{fact lease.minSeconds}} to {{fact lease.maxSeconds}}, default {{fact lease.defaultSeconds}}). Renew it during long steps:

```sh
relo work heartbeat --producer nightly-backup --lease 30m
```

A heartbeat changes nothing else. If the script dies, the lease lapses and the normal freshness rules
retire the card, so a crashed job never shows as running.

## Fail honestly

Finish from a trap, so an error never leaves the card hanging:

```sh title="nightly-backup.sh"
#!/bin/sh
set -eu
export RELO_SESSION=nightly-backup
trap 'relo work finish --failed --outcome "Backup failed during: $STEP"' EXIT

STEP="snapshot"
relo work start --goal "Back up the photo library" --plan "Snapshot,Upload,Verify" \
  --lease 30m --idempotency-key "backup-$(date +%F)"
./snapshot.sh

STEP="upload"
relo work update --next-step
./upload.sh

STEP="verify"
relo work update --next-step
./verify.sh

trap - EXIT
relo work finish --outcome "Backup verified"
```

```sh title="crontab"
# every night at 02:30
30 2 * * * /home/backup/nightly-backup.sh
```

`RELO_SESSION` replaces `--producer` on each command and also puts questions on this job's card. Cron
runs with a small environment, so give the full path to `relo` if it is not on cron's `PATH`.

## Ask before a risky step

```sh
if relo ask "Restore last night's backup over production?" --approval \
     --expires-in 30m --timeout 30m --idempotency-key "restore-$(date +%F)"; then
  ./restore.sh
fi
```

Only exit 0 with state `approved` is permission. Waiting, resuming and callbacks:
[Questions from code](/docs/guides/asking).

## CI

CI and containers skip `relo auth login`. From your own signed-in computer, make the pipeline its own CI
token with only the scopes it needs:

```sh
relo auth token create --client-name "Deploy pipeline" --scope activities:write --scope interactions:create \
  --scope interactions:read --expires-in 30d --secret-file ./deploy-relo-token
```

A CI token holds at most your login's scopes, always expires (after {{fact credentials.ciTokenDefaultDays}} unless you
say otherwise, at most {{fact credentials.ciTokenMaxDays}}) and cannot make another. Keep it in the CI's secret store,
delete the file, and set `RELO_TOKEN` and `RELO_API_URL` there; they override the config file. Never pass a token
as a flag or print it. `relo auth token list` shows your CI tokens and when each was last used; `relo auth token
revoke key_…` ends one at once, and `relo auth token rotate key_…` gives it a new secret (same name, scopes and
expiry) while the old one stops working at once.

```yaml title=".github/workflows/deploy.yml"
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      RELO_API_URL: https://relo.example.com
      RELO_TOKEN: ${{ secrets.RELO_TOKEN }}
      RELO_SESSION: deploy-web
    steps:
      - uses: actions/checkout@v4
      # install the CLI as in /docs/get-started/cli
      - run: npm install --global "${{ vars.RELO_CLI_TARBALL }}"
      - run: relo work start --goal "Deploy web ${{ github.ref_name }}" --plan "Build,Test,Ship" --idempotency-key "run-${{ github.run_id }}"
      - run: npm ci && npm run build && relo work update --next-step
      - run: npm test && relo work update --next-step
      - run: relo ask "Ship ${{ github.ref_name }} to production?" --approval --expires-in 30m --timeout 30m --idempotency-key "ship-${{ github.run_id }}"
      - run: ./deploy.sh
      - if: success()
        run: relo work finish --outcome "Web ${{ github.ref_name }} is live"
      - if: failure()
        run: relo work finish --failed --outcome "Deploy of ${{ github.ref_name }} stopped"
```

A denied, expired or unanswered question exits non-zero, so the step fails and the deploy never runs.

## Exit codes

Branch on the exit code, not on the output:

{{exit-codes}}

After exit 6 (network), retry with the same idempotency key. More: [exit codes](/docs/reference/exit-codes),
[environment](/docs/reference/environment).
