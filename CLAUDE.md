# Ticketing System — Engineering Conventions

Source of truth for requirements: `update-plan.md` (sections 21–22 hold the stack and proposed defaults). If code and plan disagree, stop and raise it; do not silently pick one.

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
infra/              docker-compose (postgres, mailpit, minio, clamav), Dockerfiles, CI
docs/adr/           Architecture decision records (one file per decision)
```

Dependency direction: `web → contracts`, `api → domain + contracts`, `domain →` nothing framework-specific. `packages/domain` must not import NestJS, Prisma, React, or Node I/O.

## Rules every change follows

1. **Authorization is server-side and central.** Every endpoint goes through the policy in `packages/domain` via API guards: ticket, field, attachment, search result, count, export, notification. Default deny.
2. **Tenant isolation.** Never query without tenant scope. Repositories take tenant from the request context, never from client input. RLS policies back this up.
3. **Transactions.** Ticket creation = number allocation + ticket + routing/audit event + pending notification in one transaction. Notifications send after commit.
4. **Concurrency.** Updates use a `revision` column (optimistic locking). Conflicts return HTTP 409 with current values; never overwrite silently.
5. **Idempotency.** Create endpoints accept an `Idempotency-Key`; retries return the original result.
6. **Audiences.** Customer messages and internal work notes are separate kinds with an explicit audience. Internal content must never reach employee views, notifications, or exports.
7. **Audit.** State, assignment, routing, priority, approval, and configuration changes write append-only audit events.
8. **Migrations.** Prisma Migrate only; never edit an applied migration. Every schema change ships with a migration and updated seed data.
9. **No hard-coded customer data.** Categories, departments, branding, prefixes come from tenant settings/seed.
10. **Licences.** Add only MIT/Apache-2.0/BSD/ISC dependencies. Ask before adding anything else, or any new dependency that duplicates the standard library or an existing package.
11. **Logs.** Structured, with request ID. Never log ticket text, attachment content, passwords, tokens, or session IDs.
12. **UI text** goes through i18n keys. Components meet WCAG 2.2 AA; status colour always has text.

## Commands (to be created in phase 2 scaffolding)

```
pnpm install
pnpm dev            # docker compose up + api + web
pnpm db:migrate     # prisma migrate dev
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
