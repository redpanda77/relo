# docs/site: the Relo docs

These files are the public docs every Relo server serves at `/docs`. They are built, with facts from the
code, into `apps/server/src/web/docs/site.generated.ts`:

```sh
pnpm --filter @relo/server docs:build
```

The build fails on a broken link or anchor, a page missing from `nav.json` (or a file not in it), an unknown
embed, or **docs drift**: a `relo …` command or `--flag` that the CLI does not have. Run it after every edit.

## A page

```md
---
title: Scripts, cron and CI
nav: Scripts and CI
summary: Your jobs report progress and ask before risky steps, from any script or pipeline.
---

## Why

…
```

- `title` is the H1 (do not write a `#` heading). `nav` (optional) is the shorter sidebar label.
- `summary` is one sentence: the lede under the title, the search snippet and the meta description. It says what
  the reader gets, not what the page contains ("Your jobs report progress", not "This page describes scripts").
- Headings: `##` sections and `###` subsections make the "On this page" outline; `####` is for reference entries.
  Headings are short and specific. Link to a heading with `/docs/path#heading-slug` (lowercase, `-` for spaces).
- File `docs/site/a/b.md` is `/docs/a/b`; a section's own page is `a/index.md` (`/docs/a`).

## Voice

Relo's voice (`docs/VALUE-PROPOSITION.md`):

- **Why before how.** Open each page with what the owner gets, in one or two sentences, then the steps.
- **Short sentences, real words, real commands.** No marketing, no filler ("simply", "just", "powerful", "seamless").
- **Name all three sources** where it fits: agents, scripts and jobs, apps and services.
- **Second person** ("your server", "you approve"). The reader is the owner, or an integrator.
- **One fact, one home.** Do not restate a command's flags: embed it (`{{command work start}}`) or link to its
  reference (`/docs/reference/cli/work#relo-work-start`). Prose explains when and why; the reference says exactly what.
- No internal plan names, dates, ticket ids ("DOGFOOD #20", "plan 04 §2.9", "E6.4") or the maintainer's name or host.
  Example values: `relo.example.com`, `you@example.com`, `nightly-backup`, `Deploy 0.7.57`.
- Only what is true in the code today. When unsure, read the code (`packages/cli/src`, `apps/server/src`).

## Building blocks

Code (shell blocks get a copy button; `#` lines are comments and are not copied):

````md
```sh title="On the server"
docker compose up -d
```
````

Callouts (`note` violet, `tip` mint, `warning` orange for what waits on you, `privacy` cyan, `never` red):

```md
:::warning Only approved is permission
A yes/no answer, an expired question or any error means no.
:::
```

Numbered steps (tutorials), portal tiles (section pages):

```md
<ol class="docs-steps">
<li>

**Install the CLI.** …

</li>
</ol>

<ul class="docs-tiles">
<li><a href="/docs/guides/scripts"><strong>Scripts, cron and CI</strong>Report progress and ask before risky steps.</a></li>
</ul>
```

Leave a blank line after `<li>` and before `</li>` so the inside is Markdown.

Embeds, each on a line of its own, render facts from the code:

| Embed | Renders |
| --- | --- |
| `{{command work start}}` | the command's usage line |
| `{{cli work}}` | every command of a CLI reference page (work, questions, notify, setup, account, keys, admin, machine) |
| `{{exit-codes}}` | the exit code table |
| `{{environment}}` | the environment variable table |
| `{{harnesses}}` | what `relo setup` writes for each harness |
| `{{api /api/producers /hooks}}` | every HTTP operation under those path prefixes, from `docs/api/openapi.json` |
