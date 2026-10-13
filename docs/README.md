# Relo documentation

Relo is a self-hosted developer notification and phone-decision system. These are the maintained
documents for contributors and operators:

- [`ROADMAP.md`](../ROADMAP.md) — the single current plan, priorities, user stories, dependencies,
  and release sequence;
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime boundaries and ownership;
- [`SELF-HOSTING.md`](SELF-HOSTING.md) — current installation and operation guidance;
- [`HARDENING.md`](HARDENING.md) — what protects a publicly reachable server and the open gaps;
- [`INTEGRATING.md`](INTEGRATING.md) — asking the owner from an app, script or service: answers,
  callbacks, `relo listen`, exit codes; [`api/openapi.json`](api/openapi.json) describes the HTTP API
  and [`CHOICE-QUESTIONS.md`](CHOICE-QUESTIONS.md) the option-question wire format;
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — local toolchain, tests, and contribution workflow; and
- [`adr/`](adr/) — accepted architectural decisions.

Superseded plans, personal configuration, deployment topology, generated reports, and local agent
state are not part of the public source tree.
