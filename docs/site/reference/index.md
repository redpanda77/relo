---
title: Reference
summary: Every command, flag, exit code, variable and route, generated from the code.
---

The guides say when and why; these pages say exactly what. They are generated from the code itself:
the CLI's command registry and options, its exit codes, environment variables and harness catalog,
and the server's OpenAPI document. The build fails when a page names a command or flag that does not
exist, so what you read here is what your CLI accepts. The same reference is in your terminal: `relo
help all`, and `relo schema` as JSON.

## The CLI

<ul class="docs-tiles">
<li><a href="/docs/reference/cli"><strong>The relo command</strong>Global options, output, dry runs and who each command is for.</a></li>
<li><a href="/docs/reference/exit-codes"><strong>Exit codes</strong>What every exit status means, for scripts that branch on it.</a></li>
<li><a href="/docs/reference/environment"><strong>Environment variables</strong>Every variable the CLI reads, for CI, containers and other harnesses.</a></li>
<li><a href="/docs/reference/files"><strong>Files and folders</strong>Everything Relo writes on a computer, and where.</a></li>
<li><a href="/docs/reference/harnesses"><strong>Harnesses</strong>What relo setup writes for each agent harness.</a></li>
<li><a href="/docs/reference/limits"><strong>Limits</strong>Rates, text lengths and how long a question can wait.</a></li>
</ul>

## HTTP

<ul class="docs-tiles">
<li><a href="/docs/reference/api"><strong>HTTP API</strong>Every route for scripts, apps and services, with its fields.</a></li>
<li><a href="/docs/reference/callbacks"><strong>Answer callbacks</strong>The signed POST Relo sends when you answer, and its retries.</a></li>
</ul>
