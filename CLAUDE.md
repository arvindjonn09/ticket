# Ticketing System — Engineering Conventions

Source of truth for requirements: `update-plan.md` (sections 21–22 hold the stack and proposed defaults). If code and plan disagree, stop and raise it; do not silently pick one.

Read [orchestrator.md](.claude/agents/orchestrator.md) for task distribution, model selection, concise handoffs, and review gates. Plan section 23 records the five resolved review findings. GPT model choices apply only in runtimes that expose them; these role briefs do not configure another provider's models.

## Product context

- Commercial, multi-tenant product. First customer: one company, ~100 users. Every business table has `tenant_id`; every query is tenant-scoped.
- Ticket types: Incident (`INC0001…`) and Service request (`SR0001…`), numbered per tenant per type.
- Category → department routing is a direct lookup from admin configuration. No AI, no rules engine.

## Repository layout

```
apps/api            NestJS (Fastify) HTTP API, auth, guards, jobs, Prisma repositories
apps/web            React + Vite SPA (employee, support, approver, admin workspaces)
packages/domain     Framework-free TypeScript: state machines, routing, approval evaluation, permission policy
packages/contracts  Zod request/response schemas shared by api and web; OpenAPI generated from these
infra/              docker-compose (postgres, mailpit, RustFS, clamav), Dockerfiles, CI
docs/adr/           Architecture decision records (one file per decision)
```

Dependency direction: `web → contracts`, `api → domain + contracts`, `domain →` nothing framework-specific. `packages/domain` must not import NestJS, Prisma, React, or Node I/O.

## Rules every change follows

1. **Authorization is server-side and central.** Every endpoint goes through the policy in `packages/domain` via API guards: ticket, field, attachment, search result, count, export, notification. Default deny.
2. **Tenant isolation.** Repositories take tenant from validated authentication context, never an unverified client field. Tenant-owned relationships use composite foreign keys including `tenant_id`; ticket numbers are unique on `(tenant_id, type, sequence)`. Set transaction-local RLS context on the same connection for API and worker business queries; missing context denies access. Runtime roles must be non-owner, non-superuser, and without BYPASSRLS; migrations use a separate role. Recheck job tenant, record, recipient permissions, and tenant status before handling business data.
3. **Transactions.** Ticket creation = number allocation + ticket + routing/audit event + notification outbox record in one Prisma transaction. A dispatcher enqueues committed outbox events to pg-boss with a stable event identity and retry handling. Email sends only after commit; no separate pre-commit queue write. A crash/retry must not lose an event or repeat a ticket/approval action. SMTP delivery may duplicate after an ambiguous acknowledgement; do not claim exactly-once email.
4. **Concurrency.** Updates use a `revision` column (optimistic locking). Conflicts return HTTP 409 with current values; never overwrite silently.
5. **Idempotency.** Scope create keys to tenant, authenticated actor, and operation. Store a request fingerprint; same-key/same-payload retries return the authorized original result, while changed payloads conflict. Concurrent retries create one result.
6. **Audiences.** Customer messages and internal work notes are separate kinds with an explicit audience. Internal content must never reach employee views, notifications, or exports.
7. **Audit.** State, assignment, routing, priority, approval, and configuration changes write append-only audit events.
8. **Migrations.** Prisma Migrate only; never edit an applied migration. Every schema change ships with a migration and updated seed data.
9. **No hard-coded customer data.** Categories, departments, branding, prefixes come from tenant settings/seed.
10. **Licences.** Add only MIT (including MIT-0)/Apache-2.0/BSD/ISC dependencies. For dual-licensed packages choose an allowed licence explicitly (for example, type-fest's MIT option). Ask before adding anything else, or any new dependency that duplicates the standard library or an existing package.
11. **Logs.** Structured, with request ID. Never log ticket text, attachment content, passwords, tokens, or session IDs.
12. **UI text** goes through i18n keys. Components meet WCAG 2.2 AA; status colour always has text.
13. **Terminal states and delegates.** Complete, Cancelled, and Rejected are terminal for customer messages/uploads; enforce allowed actions server-side. Approval delegates must be active, eligible users in the same tenant, within the delegation period, with no self-approval or delegation-chain bypass. Record the original approver and actual decision-maker.

## Commands

```
pnpm install
pnpm dev            # API + web; start the database separately (see README)
pnpm db:migrate     # apply committed Prisma migrations
pnpm db:seed        # demo tenant, users, departments, categories
pnpm lint && pnpm typecheck
pnpm test           # vitest unit + integration (real postgres)
pnpm test:e2e       # playwright
```

## Testing

- Domain rules (state transitions, routing, approval evaluation, permission policy): unit tests, table-driven.
- Repositories and transactions: integration tests against real PostgreSQL (no DB mocks), including concurrency tests for numbering, claiming, and approval decisions.
- Each item in the plan's acceptance checklist (section 13) maps to at least one automated test; name tests after the checklist item.
- E2E (Playwright) covers the four journeys: employee submit, agent claim/resolve, approver decide, admin category/mapping.

## Definition of done

Lint, typecheck, and tests pass; new behaviour has tests; authorization and tenant scope are covered by a negative test (another user/tenant is denied); migration and seed updated; no internal content leaks in employee-facing responses; plan section referenced in the PR/commit message.
