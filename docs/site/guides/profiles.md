---
title: Several computers and logins
nav: Computers and logins
summary: Every computer, job and agent account shows up under its own name, so you always know where a card came from.
---

## Why

Your agents and jobs run on a laptop, a desktop, a home server and in CI. When a card says "Tests
failing", you want to know which machine and which agent account it came from, and you want to revoke
one computer without touching the others. Relo keeps three names apart:

| Name | Tells apart | Set by |
| --- | --- | --- |
| **Login** (client name) | each computer or job signed in to your server | `relo auth login --client-name` |
| **Computer** | where a card ran | automatic; `RELO_COMPUTER` |
| **Agent account** | which Claude or Codex account ran it (work, personal) | `relo account NAME`; `RELO_ACCOUNT` |

A **profile** is a second sign-in on the same computer, for a job that should have its own login.

## One login per computer

Sign in once on each computer. The login is named after the computer by default; give it a clearer name
if you like:

```sh
relo auth login --api-url https://relo.example.com --client-name "Studio desktop"
```

Keep names unique per machine: a login is replaced when the same name signs in again. Each login appears
in the Dashboard, where you can revoke it on its own. `relo auth status` shows who is signed in here.
Every flag: [account reference](/docs/reference/cli/account).

## Profiles for separate jobs

An app or job that should be revocable on its own, or scoped to less, gets its own sign-in beside yours:

```sh
relo auth login --profile billing --client-name "Billing app"
```

Then pick it per command, or make it the active one:

```sh
RELO_PROFILE=billing relo ask "Refund order 8812 (240 EUR)?" --approval
relo auth switch billing
```

`relo auth status` shows the active profile. `RELO_TOKEN` and `RELO_API_URL` still win over any profile,
which is how CI signs in (see [Scripts, cron and CI](/docs/guides/scripts#ci)). The one-time phone test
is remembered per profile.

## Computer names

Each card shows the computer it ran on: the Mac's name, else the hostname. Override it when the hostname
says nothing, for example on a server or in a container:

```sh
export RELO_COMPUTER="Home server"
```

`--computer NAME` on a single command does the same.

## Agent accounts

If you run Claude Code or Codex under two accounts on one computer (a work and a personal one), the card
says which. Relo detects a custom config folder by its name (`~/.claude-work` becomes "work") without
reading anything inside it. Name an account yourself from a session that runs under it:

```sh
relo account work
```

With no name it shows the current one; `--clear` removes the nickname. `RELO_ACCOUNT` sets it for every
command in a shell, and `--account NAME` for one.

## Check it

- `relo auth status` shows the server, the login and the profile.
- Start a card from each computer: its details show the computer and the account.
- In the Dashboard, each login is listed by its client name, ready to revoke.

All variables: [environment reference](/docs/reference/environment). How names are picked, in order:
`relo help identity`.
