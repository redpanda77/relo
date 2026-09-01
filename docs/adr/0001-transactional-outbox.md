# ADR 0001: PostgreSQL transactional outbox

## Status

Accepted.

## Decision

Relo stores canonical product state and pending delivery work in PostgreSQL in the same transaction.
A separate worker leases outbox jobs, talks to APNs, and records each result.

## Why

The API must never report a notification or decision request as durable while its delivery work can
still be lost between two systems. A database outbox gives one commit boundary, supports retries,
and keeps provider acceptance distinct from a phone receipt.

## Consequences

- PostgreSQL is required; the API does not publish directly to APNs.
- Workers must use bounded leases and idempotent retry behavior.
- Queue state is operational detail; canonical notification and interaction state remains in the
  domain tables.
