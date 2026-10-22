# Architecture decision records

An ADR records one decision, why it was made and what follows. Accepted records are not edited to
change the decision; a new record supersedes the old one and both link to each other. A record may
be amended while its decision is being implemented, and says so in its status.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-transactional-outbox.md) | PostgreSQL transactional outbox | Accepted |
| [0002](0002-single-owner-self-hosting.md) | Single-owner self-hosting | Superseded by 0004 |
| [0003](0003-private-network-first.md) | Private-network-first access | Superseded by 0006 |
| [0004](0004-isolated-multi-user-accounts.md) | Isolated multi-user accounts | Accepted |
| [0005](0005-end-to-end-encrypted-content.md) | End-to-end encrypted content | Accepted |
| [0006](0006-operator-chosen-origin.md) | Operator-chosen origin, private or public | Accepted |
| [0007](0007-presence-messages-work-separation.md) | Presence, messages and work are separate | Accepted, implemented |
| [0008](0008-relo-design-framework.md) | Design framework: state sources, producer types, the CLI as the edge | Accepted, implemented; refines 0007 |
| [0009](0009-cli-structure.md) | CLI structure: type modules, one registry, one descriptor per harness, setup as one plan | Accepted, implemented; applies 0008 |
| [0010](0010-shared-server-modules.md) | Shared server modules: credentials, scopes, webhooks, request policy, card actor, facts, content policy, origin rule | Accepted, implemented; applies 0008 and 0009 |
| [0011](0011-computers.md) | Computers: one record per login with a display name, an icon, the machine's report and signed setting requests | Accepted, being implemented; applies 0008 and 0010 |
| [0012](0012-working-layer.md) | Working layer: rounds, plan trees, prompt-time continuity, handoff, lifecycle safety, setup depths | Accepted, being implemented; amends 0007 and 0008 |
| [0013](0013-sensory-language.md) | One sensory language: moments mapped to sound, haptics and motion on the Mac app, the iPhone app and the Dashboard; one sound set from earshot; one motion vocabulary | Accepted, being implemented |
| [0014](0014-spoken-line.md) | The line Relo for Mac says aloud: written by the producer (`--say` on deliver and finish), sealed inside the card, no server field | Accepted; amended by 0015 |
| [0015](0015-spoken-message-frame.md) | One frame for every spoken update: kind, name, gist, with lengths by urgency; the agent writes the line (`--say`), the CLI echoes `Mac says:`; a voice level set per computer or project and capped by the Mac | Accepted, implemented; amends 0013 and 0014 |

Start with 0007 and 0008 to understand how Relo's state is organized.
