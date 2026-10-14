# Relo documentation

Relo brings decentralized agents and automations (agents on any machine and harness, scripts and
scheduled jobs, apps that need a human in the loop) together in one place on the owner's iPhone,
through a server the owner runs. These are the maintained documents for contributors and operators.

- [`VALUE-PROPOSITION.md`](VALUE-PROPOSITION.md): why Relo exists and how to state it; read before
  changing product copy, the landing page or these docs

## Use and operate

- [`SELF-HOSTING.md`](SELF-HOSTING.md): installation and operation
- [`HARDENING.md`](HARDENING.md): what protects a publicly reachable server, and the open gaps
- [`END-TO-END-ENCRYPTION.md`](END-TO-END-ENCRYPTION.md): threat model, protocol and state of
  end-to-end encryption
- [`HOOKS-AND-HARNESSES.md`](HOOKS-AND-HARNESSES.md): optional hooks, their levels, what leaves the
  computer, and how to add a harness

## Integrate

- [`INTEGRATING.md`](INTEGRATING.md): reporting work, asking the owner and getting the answer from
  an app, script or service (callbacks, `relo listen`, exit codes)
- [`api/openapi.json`](api/openapi.json): the HTTP API, generated from the server's request schemas
- [`CHOICE-QUESTIONS.md`](CHOICE-QUESTIONS.md): the option-question wire format

## Understand

- [`ARCHITECTURE.md`](ARCHITECTURE.md): runtime boundaries, the state model (declared, observed,
  derived) and the split between the CLI and the server
- [`RELEVANCE.md`](RELEVANCE.md): what earns the owner's attention
- [`DELIVERY-SCHEDULING.md`](DELIVERY-SCHEDULING.md): how pushes are ordered and dispatched
- [`LATENCY.md`](LATENCY.md): the reproducible local latency baseline
- [`adr/`](adr/README.md): accepted architectural decisions

## Contribute

- [`DEVELOPMENT.md`](DEVELOPMENT.md): toolchain, local gates, working on the CLI
- [`TESTING.md`](TESTING.md): the test gates and the invariants they pin
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): contribution workflow
- [`../ROADMAP.md`](../ROADMAP.md): the single current plan

Research, operator topology, generated reports and local agent state are not part of the public
source tree.
