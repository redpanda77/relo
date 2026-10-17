---
title: relo ask, relo interaction and relo listen
nav: ask and answers
summary: Every command and option that asks you a question and gets your answer back.
---

`relo ask` puts one question on the open work's card (or, with no card, in a notification with the
answer buttons) and waits for your tap. `relo interaction` reads, resumes waiting on, or withdraws a
question by its id. `relo listen` streams every answer this login receives over one connection, for
services that ask many questions. How questions behave: [Questions](/docs/concepts/questions); from
code: [Questions from code](/docs/guides/asking).

Branch on the exit status, never on the wording: 0 means answered (read `state`; only `approved` is
permission), 5 denied or no, 4 still open, 8 closed without an answer. The full table:
[Exit codes](/docs/reference/exit-codes).

```sh
relo ask "Deploy 2.4 to production?" --approval --detail "Migration 0042 rewrites orders. Undo: rollback 0042."
```

## Commands

{{cli questions}}
