---
title: Questions and answers
nav: Questions
summary: Your agents, scripts and apps ask before risky steps, you answer from the Lock Screen, and nothing proceeds without a signed yes.
---

A question puts you in the loop at the moment it matters: before a deploy, a migration, a refund. The
producer waits for your answer and carries on. Silence is never consent: no answer means no.

## Three kinds of question

| Kind | Buttons | Use it for |
| --- | --- | --- |
| Approval | Approve, Deny | permission for one exact action |
| Yes/no | Yes, No | a fact or a preference |
| Choice | two to four labelled options | picking a path: "Ship", "Wait", "Roll back" |

The question itself is one self-contained line of at most 120 characters, because you may answer
it from the Lock Screen without any other context. Why it asks, the risk and how to undo it go in
the detail, which you read in Relo. There are no typed replies: every answer is a tap.

## Asked on the work's card

A question belongs to the work it is about. `relo ask` puts it on the open work's card, which moves
to the top of your Lock Screen and alerts as time-sensitive. One question at a time: a work that
already waits on you cannot ask a second one until the first is answered or withdrawn.

When there is no card (a script without a work, an app using `--notification-only`), the question
arrives as a notification with the same buttons. Apps and services ask over the HTTP API and get
the answer by a signed callback; see [apps and services](/docs/guides/apps).

## Only approved is permission

:::warning Only approved is permission
A producer may take a protected action only when an approval question comes back `approved`.
Everything else means no: Deny, No, a picked option, expiry, a withdrawn question, a timeout, an
error, or no phone reachable.
:::

A yes is an answer to a question, not a permission, even when the wording sounds like one. A
picked option is a preference: anything risky still needs its own approval. Each approval covers
one exact action; if the action changes, the producer asks again.

The CLI makes this mechanical: `relo ask --approval` exits `0` only with state `approved`, `5` for
denied or no, `4` while the question is still open, and `8` when it closed without an answer. See
[exit codes](/docs/reference/exit-codes).

## Signed answers

Your iPhone signs every answer with its identity key, which lives in the Secure Enclave, at the
moment you tap: in the app, on a notification, or on the Lock Screen card. Once a computer trusts
your phone, the CLI accepts approved, yes or a choice only with a valid signature from a trusted
phone, bound to that exact question and made after it was asked. A server, even a compromised one,
cannot invent your approval or replay an old one onto a new question. A missing or bad signature
means do not act. More in [end-to-end encryption](/docs/concepts/encryption).

A question on a card reaches each of your phones as its own copy, and one that outlives its card
continues as a notification in Relo. Answer on whichever is in front of you: each phone signs its own
copy, bound to the encrypted question the computer sealed, and the computer counts that answer for
the question it asked.

## Answering from the Dashboard

A browser you linked from your iPhone answers too: the same buttons, the time left, and for an
approval a plain "This lets Claude Code proceed" before you confirm. The browser signs with its own
key, the same way the phone does, and can answer only questions it can read. The computer that asked
counts a browser's answer only while a phone it trusts linked that browser in the last 14 days, and
never in strict mode (`relo keys strict on`): there only a phone's signature counts, and a browser's
answer is treated as no answer (exit `8`). The producer sees which browser answered. An unlinked
browser shows "Link this browser from your iPhone to answer here". A question on a card reaches each
of your phones as its own copy; the browser always answers the copy the asking computer waits on, so
its answer counts there too. An encrypted question the computer sealed only to your phones shows
"Answer it on your iPhone" in place of buttons.

## Waiting, expiry and late answers

A question stays answerable until it expires: five minutes by default, longer with `--expires-in`.
One answer decides it, from whichever phone or linked browser answers first.

- **Waiting.** Inside an agent session the command waits about 100 seconds, because a harness kills
  long shell commands. If you have not answered yet, it exits `4` and the agent resumes with
  `relo interaction wait`. The question stays open on your phone the whole time.
- **Expiry.** When the time runs out, the question expires on every phone at once and the producer
  treats it as no. It stays under Needs you as missed until you open or dismiss it, so you know a
  decision passed you by. A dismissed question refuses a late answer.
- **Late answers.** An answer that arrives after the producer stopped waiting is recorded and shown
  to it as a fact ("late: not permission"). It is never permission: the producer asks again if it
  still needs to.

## Good questions

- Ask only when the work depends on the answer.
- Put the decision in the line ("Deploy 0.17 to production?"), the reasons in the detail.
- Never put commands, file contents, secrets or paths in a question.

Next: [asking from scripts and apps](/docs/guides/asking), [the questions commands](/docs/reference/cli/questions).
