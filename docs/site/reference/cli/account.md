---
title: Sign-in, checks and phones
nav: sign-in and checks
summary: Every command that signs this computer in, checks the installation, names the account and lists phones and services.
---

`relo auth` signs this computer in through the browser, with one profile per login when you need
several. `relo doctor` checks the installation and names the next step; `relo test` sends the first
card that proves the phone gets it. `relo account` names the Claude or Codex account a session runs
under, `relo devices list` shows the account's phones, and `relo services` creates and lists webhook
services. Guide: [Several computers and logins](/docs/guides/profiles).

```sh
relo auth login
relo doctor
relo test
```

## Commands

{{cli account}}
