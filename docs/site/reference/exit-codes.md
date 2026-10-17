---
title: Exit codes
summary: What every relo command's exit status means, for scripts that branch on it.
---

Every `relo` command exits with one of these codes. Branch on the code, not on the wording of the
output: the code is the contract, the text may change.

## Codes

{{exit-codes}}

## Branching on an answer

For a question, only exit 0 with state `approved` is permission. Every other outcome means do not
act: a denial, a no, a question that is still open, one that expired or was withdrawn, and any error.

| Code | For `relo ask` | What your script does |
| --- | --- | --- |
| 0 | answered: approved, yes, or an option chosen | read `state`; act only on `approved` |
| 5 | denied or no | do not act |
| 4 | still open: this command stopped waiting | resume with `relo interaction wait ID`, or treat as no |
| 8 | closed without an answer (expired, canceled), or an answer this computer could not verify (state `unverified`: unsigned, an untrusted phone, a browser in strict mode or without a current link) | do not act; a late answer is still no |
| 1, 2, 3, 6, 7 | an error | do not act; read the hint |

```sh
relo ask "Deploy 2.4 to production?" --approval > answer.json
case $? in
  0) jq -e '.state == "approved"' answer.json >/dev/null && ./deploy.sh ;;
  4) echo "Still waiting; resume later with relo interaction wait" ;;
  *) echo "Not approved; skipping the deploy" ;;
esac
```

## Retrying errors

- **6 network**: retry with the same `--idempotency-key`, so a request that did arrive is not repeated.
- **3 authentication or scope**: the login is missing, expired, revoked or lacks a scope. Retrying
  does not help; sign in again with `relo auth login`, or stop if the owner revoked it.
- **7 no phone accepted the push**: run `relo doctor`.
- **2 usage**: fix the command; the hint shows a corrected one.
