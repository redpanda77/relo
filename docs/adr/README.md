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

Start with 0007 and 0008 to understand how Relo's state is organized.
