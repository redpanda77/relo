# ADR 0004: Isolated multi-user accounts

## Status

Accepted. Supersedes [ADR 0002](0002-single-owner-self-hosting.md).

## Context

ADR 0002 made one installation belong to one owner. The data model already scopes every
owner-visible resource to an owner principal, but the entry points assume there is only one:
sign-up is refused once any identity exists, every new identity joins the bootstrapped principal,
and account deletion recreates that principal. Users an owner adds join the owner's principal and
see the same data.

## Decision

One installation hosts several people. Each person has their own account and nothing is shared.

- **One principal per person.** Sign-up creates a new owner principal with one identity. Devices,
  CLI credentials, services, notifications, interactions, Live Activities and resources belong to
  that principal, exactly as today.
- **Isolation is the default and is tested.** A request authenticated for one principal never
  reads, changes or learns the existence of another principal's resources. A foreign identifier
  answers the same way as an identifier that does not exist. A route-coverage test fails when a
  new route is added without an isolation classification.
- **Server administration is separate from data ownership.** The first account to sign up becomes
  the server admin. The admin manages accounts (approve, disable, delete, sign out) and sees only
  account metadata: name, email, status and creation time. Administration grants no access to
  another account's devices, cards or content.
- **Registration has three modes**, set by the admin: `closed` (the admin creates accounts),
  `approval` (anyone may register; the account cannot sign in until approved) and `open`.
  The default for a new installation is `closed` after the first account.
- **No new shared principals.** People the admin adds get their own account. Members added to an
  owner's principal before this decision keep that shared access, shown as "Shared access" on the
  owner's account page, until the owner disables them; explicit sharing may return later.
- **The admin cannot read or impersonate an account.** Administration covers approve, revoke
  access (every session, CLI key, service and phone credential stops working; data is kept),
  restore access, sign out everywhere, and delete. It does not reset another account's password.
- **Account requests are Relo approvals.** In approval mode a registration reaches the admin as
  one decision shown twice by a built-in "Relo accounts" service on the admin's account: a
  notification with Approve and Deny that waits 30 days (listed under Needs you in the app and the
  Dashboard), and a question card on the Lock Screen for up to 8 hours when a phone can show Live
  Activities. The two form a *decision group*: answering either one decides, and the other takes
  the same outcome in that transaction. Deciding under Server accounts settles both the same way.
  A database trigger applies the decision to the account (approve lets the person in, deny turns
  access off). The group counts once in Needs you and the badge. The Dashboard keeps a request
  pending after its approval expires.
- **Installation-wide infrastructure stays shared.** One APNs key, one database, one worker and
  one set of rate limits serve every account. Open registration additionally needs per-account
  quotas.

## Consequences

- The bootstrapped principal remains the first account's, so an existing installation keeps its
  data; migration 0061 makes the earliest owner the server admin. Every later account gets a new
  principal, and deleting it never recreates anything. The admin cannot delete their own account
  while other accounts exist.
- The Dashboard sign-in page offers registration according to the mode and shows a
  waiting-for-approval state. The iPhone signs in through the same page, so it needs no native
  change.
- Encryption that hides content from the server admin is a separate decision: the server must read
  Live Activity content to push it, so end-to-end encryption can cover ordinary notifications only.
- Privacy guarantees are only as strong as the isolation suite, which must cover every route.
