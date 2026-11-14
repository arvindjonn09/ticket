# ADR 004: Shared tenant operation locks

Status: accepted 14 November 2026.

## Context

The API previously took one exclusive PostgreSQL advisory lock for nearly every operation in a tenant. That made independent reads and ticket writes queue behind each other. Configuration changes still need to serialize against ticket mutations that depend on routing, membership, request policy, or SLA settings.

## Decision

Ticket operations and background dispatch use `pg_advisory_xact_lock_shared` on the tenant configuration key. Changes to organisation routing, membership, request policy, SLA and automation policy, inbound mail settings, and operator data lifecycle use the exclusive `pg_advisory_xact_lock` on the same key. Pure reads of ticket lists/details/catalogs and reports rely on their transaction snapshot and RLS without this advisory lock.

Operations that update one ticket continue to use ticket revision checks and narrow idempotency locks. The shared lock coordinates them with configuration changes without serializing peers. Keep lock acquisition before reading the configuration-dependent state, and keep each operation in one transaction.

## Consequences

Unrelated tenant ticket operations can proceed concurrently. A configuration change waits for in-flight ticket operations and prevents new ones from observing a partially applied configuration. Pure reads may observe the prior or new committed configuration according to their transaction snapshot, which is acceptable for read-only responses.

The existing concurrency and 100-account smoke checks remain required. The smoke is not a capacity benchmark; record its observed p50/p95 alongside this decision rather than treating it as a production guarantee.
