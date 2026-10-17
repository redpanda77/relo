---
title: Harden a public server
nav: Hardening
summary: A checklist for a Relo server on a public address, and what already protects it without you.
---

On a public address, anyone on the internet can reach your server's sign-in page. Relo is built so
that its own sign-in holds without a VPN or a proxy login in front, and so that even a server that is
broken into cannot read your content or approve on your behalf. A few choices are still yours; make
them before you share the address.

## Checklist

<ol class="docs-steps">
<li>

**Turn on two-step sign-in for every account, yours first.** Account → Security → Two-step sign-in
adds codes from an authenticator app (the Passwords app on iPhone works) and ten one-time backup
codes. After that, a password alone signs in nowhere, the iPhone included. Use a long, unique
password as well.

</li>
<li>

**Keep registration Closed or Approval.** Account → Server. A public address cannot use Open; it
acts as Approval. See [Accounts](/docs/guides/accounts#who-can-register).

</li>
<li>

**Set `RELO_CLIENT_IP_HEADER`** to the header your proxy overwrites with the client's address
(`cf-connecting-ip` behind Cloudflare), never `x-forwarded-for`. Without it, the per-client sign-in
limits become one limit shared by everyone. See [Your server's address](/docs/guides/origin#configure-the-server).

</li>
<li>

**Keep strict mode on.** A computer signed in to a server on a public address is in strict mode unless you
turn it off; on a private network (a `.local` name, a LAN or Tailscale address) it is off unless you turn it
on. `relo keys status` says which and why; `relo doctor` shows whether your server's address is public.

```sh
relo keys strict on
```

A changed phone key, or a phone set up again after every trusted one left, then needs `relo keys
verify` before anything is sealed to it, and a linked browser can no longer approve a phone or answer
a question. The computer decides this, not the server, so a compromised server cannot turn it off. See
[Keys and phones](/docs/guides/keys#strict-mode).

</li>
<li>

**Keep the API on loopback.** `RELO_BIND_ADDRESS=127.0.0.1`, reached only through your tunnel or
proxy.

</li>
<li>

**Add a proxy login for browser pages, if your proxy has one**, such as Cloudflare Access, and let
the app, CLI and webhook paths through to Relo's own authentication. See
[Cloudflare Tunnel](/docs/guides/origin#public-cloudflare-tunnel).

</li>
<li>

**Send webhook secrets in a header**, `Authorization: Bearer hook_…` or `X-Relo-Webhook-Secret`, not
in the URL path, so they stay out of proxy, CDN and access logs.

</li>
<li>

**Set a retention window**, such as `RELO_CONTENT_RETENTION_HOURS=10`, so the server keeps no old
content. See [Content retention](/docs/guides/accounts#content-retention).

</li>
</ol>

## What already protects you

**Sign-in**

- Sign-in allows 10 attempts a minute per client and 120 for the whole server; sign-up 5 and 30;
  starting a CLI sign-in 10 and 40.
- After five wrong passwords for one email, that account's next attempt waits a second, doubling up
  to 15 minutes. A browser that has signed in to the account before skips the wait, so nobody can
  lock you out of your own browser by guessing.
- Accounts are Closed by default; the admin creates them.

**The server**

- A public origin must be HTTPS: the server refuses to start with plain `http` on a public address,
  and the CLI refuses such a server.
- Request bodies are capped at 1 MiB on every route, and HTTPS origins send HSTS.
- Dashboard pages send a strict content security policy, refuse framing, and are never cached;
  cookies are `Secure` on HTTPS.
- Containers run read-only and non-root with every capability dropped; the API and worker use a
  restricted database role.
- Fetching an image refuses private and reserved addresses, and answer callbacks go only where the
  admin allows ([Answer callbacks](/docs/reference/callbacks#where-callbacks-can-go)).

**Credentials**

- Each computer and app has its own login, revocable on its own. The hooks hold a narrower
  credential that can only report a session's phase.
- A CI token (`relo auth token create`) always expires, holds at most its maker's scopes, cannot make another
  token and cannot change the encryption requirement. Rotate any leaked secret in place: `relo auth token
  rotate`, `relo services rotate`; the old one stops at once.
- Every credential records when it was last used, and `relo doctor` lists the ones unused for
  {{fact credentials.unusedDays}} so you can revoke what you no longer need.
- A CLI login can only make the encryption requirement stricter. Turning it off takes you, signed in
  to the Dashboard.

**Your content**

- Notice, question and card text is sealed on the sending computer to your phones. The server, a
  TLS-terminating proxy, and anyone who breaks into either see only placeholders and metadata
  ([Encryption](/docs/concepts/encryption)).
- A phone added after your first one waits until a trusted phone approves it, so nothing is sealed
  to a phone the server added on its own. A computer added after your phone signed in waits for your
  approval on the phone the same way.
- Answers are signed by the phone, or by a browser a trusted phone linked. A computer acts on an
  approval only with a valid signature from a phone it trusts, or outside strict mode from a browser
  such a phone linked in the last 14 days, so a server cannot fake your yes.

## The trade-offs you accept by default

Two defaults favour things that keep working over things that stop:

- **A changed phone key is trusted again with a notice**, like WhatsApp after a reinstall. Someone
  with control of the server, or your password, could swap in a phone key of their own, and you would
  see "security code changed" or "phone set up again" rather than a block. Strict mode turns that
  into a block until you verify.
- **A linked browser can approve a new phone.** The server delivers the Dashboard's code, so a
  compromised server could make your linked browser approve a phone it added. The browser must be
  linked from a trusted phone within the last 14 days, approvals are limited to 10 per account per 15
  minutes and need a fresh two-step code when that is on, and each computer says which browser
  approved. Strict mode refuses browser approvals.
