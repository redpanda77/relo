# ADR 0002: Single-owner self-hosting

## Status

Superseded by [ADR 0004](0004-isolated-multi-user-accounts.md).

## Decision

Relo is a self-hosted, single-owner system. One browser account owns devices, CLI credentials,
services, notifications, interactions, and Live Activities. It does not implement organizations,
teams, billing, or hosted tenancy.

## Consequences

- The first account claims an installation.
- Devices, CLI clients, and webhook services receive separate revocable credentials.
- Authorization still scopes every resource to the owner even though the product is not multi-user.
- Portable installation and runtime configuration take priority over hosted-product features.
