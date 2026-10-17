---
title: See your first card
nav: 4. See your first card
summary: A live card on your Lock Screen with a plan, a question you answer from the phone, and its outcome.
---

## What you get

Proof that the whole path works, from this computer through your server to your iPhone, and a feel for
what your agents and scripts will show you: a card that moves through a plan, a question with buttons,
and one notification with the outcome.

## The one-time test

```sh
relo test
```

A short card appears on your Lock Screen and asks whether you can see it Tap **Yes**.
The phone is recorded as verified, and `relo test` is never needed again on this account (use
`relo test --again` to repeat it). If nothing appears within a minute, see
[Troubleshooting](/docs/troubleshooting).

## A real work, from your terminal

Agents get their session from the harness. In a plain terminal, name a stable key for your commands
instead, so they all land on one work:

<ol class="docs-steps">
<li>

**Start it with a goal and a plan.** The card appears on the Lock Screen and in the Dynamic Island.

```sh
export RELO_SESSION=first-card
relo work start --goal "Try Relo end to end" \
  --plan "Say hello,Ask a question,Wrap up" --idempotency-key first-card-1
```

The command prints the plan, what you see on the phone (`Owner sees: …`) and the next command. A
script names its start with an idempotency key so a retry never opens a second work.

</li>
<li>

**Move it along.** Updates are silent: the card changes, the phone does not buzz.

```sh
relo work update --status "Hello from this computer" --next-step
```

</li>
<li>

**Ask before a risky step.** The question shows on the card with **Approve** and **Deny**, and it
alerts.

```sh
relo ask "Finish the first card?" --approval
echo $?
```

Tap **Approve**: the command exits `0`. Deny, and it exits `5`. If you wait longer than it does, it
exits `4` and prints the command to keep waiting.

</li>
<li>

**Finish once, with the outcome.** The card shows it briefly and then leaves; the outcome is the one
notification.

```sh
relo work update --next-step
relo work finish --outcome "First card worked: plan, question and outcome on the phone"
unset RELO_SESSION
```

</li>
</ol>

:::warning Only approved is permission
An approval counts only with exit `0` and state `approved`. A denial, an expired question, a late answer
or any error means no, and a script must not go ahead.
:::

## What you saw

- **The card** is the live view of one work: its goal, the current step out of the plan, and the status
  in real words. A card that stops updating is dimmed after {{fact card.freshSeconds}} and leaves the Lock Screen after
  {{fact card.retireSeconds}}, so what you see is always current. See [Cards](/docs/concepts/cards).
- **The question** waited on the card until you answered. See [Questions](/docs/concepts/questions).
- **The outcome** arrived as a single notification. See [Notifications](/docs/concepts/notifications).

The same work is in the app's **Now** tab while it runs, and in **History** after.

## Check it

```sh
relo doctor
```

`ready` is now `true`. The only warning left may be the skill for your agents, which is the last step.
