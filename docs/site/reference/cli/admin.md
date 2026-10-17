---
title: relo admin, relo sessions and relo activity
nav: admin and sessions
summary: The owner's views and fixes across every session: open works, sessions and cards.
---

Everything else in Relo is scoped to the session or producer that owns it: an agent sees only its own
work. `relo admin` is the deliberate exception. It acts as your terminal does, across every session of
the account, so you can see what each one shows and end work that hangs.

- `relo admin works` lists every open and paused work, with its session and last update.
- `relo admin finish` ends a work that hangs: one that is paused, or quiet for {{fact card.freshSeconds}}. A work that
  is still moving stays its own session's and answers `work_running`.
- `relo sessions` lists the sessions the server knows from hooks (empty without them). `relo activity`
  reads, explains and ends cards.

An agent runs these only when you ask it for help, for example to clear a hanging or test card or to
check what every session shows. It never uses them to change another session's work on its own.

```sh
relo admin works
relo admin finish wrk_8f2c --dropped --outcome "Test card from a setup check"
```

## Commands

{{cli admin}}
