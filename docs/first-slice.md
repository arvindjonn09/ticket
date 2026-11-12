# First working slice — agreed implementation boundary

This records the completed initial incident slice and its original scope. Current implementation extends it with organisation administration, requests, approvals, users, files, notifications and reports. Use [completion-contract.md](completion-contract.md), [users-contract.md](users-contract.md), and [task-status.md](task-status.md) for current interfaces, ownership and verification; the historical exclusions below are not the current feature inventory.

Local Docker development, two fictional organisations (`harbour` and `northstar`), employee and agent accounts. Product name comes from tenant branding, initially Astrama. Light/dark/system themes. Initial departments: IT Support, Application Support, Infrastructure, Security, plus triage. Configuration and integrations remain tenant-owned. This slice implements incidents; full requests, approval configuration, MFA/admin management, attachments and email dispatch follow in subsequent slices. Outbox persistence is required now; no email is claimed to be delivered yet.

## Shared HTTP interface

All routes under `/api`, same origin through Vite proxy or nginx. JSON errors `{message: string}` with meaningful HTTP status. Authentication: opaque httpOnly session cookie, server session, Argon2id passwords, origin checking and `x-csrf-token` for authenticated mutations. Login body includes an organisation slug as account locator; server validates tenant + credentials before creating tenant-bound session. Disable public signup. Demo users are employee/agent only, no administrator MFA bypass.

- `GET /health` → `{status: "ok"}`.
- `POST /auth/login` body `{organisation,email,password}` → SessionView + cookie.
- `GET /auth/session` → SessionView, or 401.
- `POST /auth/logout` → `{ok:true}`.
- `GET /catalog` → `{categories: [{id,name,departmentName}], departments: [{id,name}]}` (active categories only).
- `GET /tickets` optional `search`, `state`, `priority`, `scope=all|mine` → `{tickets: TicketSummary[]}`. All means all records allowed to this actor; never all tenants. Search/filter before returning at most 200 records; label limit if reached.
- `POST /tickets` body `{categoryId,summary,description}`, `Idempotency-Key` → TicketDetail. Enforce 5–160 character summary, description 10–5000 characters, valid category.
- `GET /tickets/:id` → TicketDetail or 404 for inaccessible/missing records.
- `POST /tickets/:id/claim` body `{revision}` → TicketDetail. Agent in group only; reject already claimed or stale revisions.
- `POST /tickets/:id/messages` body `{revision,body,audience:"customer"|"internal"}` → TicketDetail. Employee may only post customer messages on own ticket; agent must be in assigned group; text 1–5000 characters.
- `POST /tickets/:id/state` body `{revision,state,resolution?,customerSummary?}` → TicketDetail. Agent: Open→In Progress and In Progress→Resolved (requires both internal resolution + public summary). Requester: Resolved→Complete or Resolved→In Progress. No other transitions in this slice.

```ts
type SessionView = {
  user: {
    id: string;
    name: string;
    email: string;
    role: "employee" | "agent";
    departmentIds: string[];
  };
  tenant: { id: string; name: string; slug: string; brandName: string };
  csrfToken: string;
};
type TicketSummary = {
  id: string;
  number: string;
  summary: string;
  description: string;
  state: "Open" | "In Progress" | "On Hold" | "Resolved" | "Complete" | "Cancelled";
  priority: "P1" | "P2" | "P3" | "P4" | "P5";
  severity: string;
  categoryId: string;
  categoryName: string;
  departmentId: string;
  departmentName: string;
  callerId: string;
  callerName: string;
  assignedToId: string | null;
  assignedToName: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type TicketDetail = TicketSummary & {
  activities: {
    id: string;
    body: string;
    audience: "customer" | "internal";
    authorName: string;
    createdAt: string;
  }[];
};
```

Public TicketSummary contains no internal resolution. TicketDetail activities are filtered on server. Sensitive category restricts staff to its group; originating employee can see own public ticket. Authorisation is centralized in framework-free domain functions and repeated server-side on each action. Prisma uses tenant transaction-local context with RLS enforced for runtime app role. Composite foreign keys protect tenant relationships. All changes include audit + outbox in transaction. Concurrency conflicts return 409 without private fields.

## Ownership

- Backend worker: `apps/api/src/`, `apps/api/prisma/`, `apps/api/test/`, `packages/domain/src/`, `packages/contracts/src/`. Includes schema, migration, seed, domain tests, API integration tests. No manifests/lockfile changes.
- Frontend worker: `apps/web/src/`, `apps/web/index.html`, `apps/web/vite.config.ts`. No manifests/lockfile changes.
- Orchestrator: all manifests/config, Docker/infra, docs, scripts, integration/visual verification and final review.

## Tooling contracts

Node 24; pnpm 10.34.9; NestJS 11.2.9/Fastify; Prisma 6.19.3; React 19; Vite 7.3.8; TypeScript 5.9.3; Zod 4.6.6 or newer within major 4; Vitest 3.2.7. Zod and Prisma's transitive deepmerge-ts were updated after the dependency audit; the lockfile records exact versions. Packages build with tsc and expose `dist/index.js` using ESM. API compiles with decorators + metadata and runs `dist/main.js` (Nest uses explicit DTO parsing, not validation decorators). Prefer tsx only for seed/tests.

Environment: `DATABASE_URL` runtime non-bypass connection, `MIGRATION_DATABASE_URL` owner connection, `APP_ORIGIN=http://localhost:4310`, `PORT=4311`, `NODE_ENV=development`, `DEMO_PASSWORD` seed-only. Seed uses owner URL, creates `astrama_app` role if absent with password from `APP_DB_PASSWORD` and grants narrow runtime rights. Seed requires demo env; no fixed production password. Local default password is documented only as a demo. Sessions use Secure cookies in production and same-origin CSRF checks in local mode. Database role setup may use provision SQL instead of seed; coordinate exact setup with root.

Checks: real database tests for login, CSRF, incident create/retry, claim/revision, reply and internal-note denial, another tenant denied, cross-tenant FK rejection, RLS absent context and transaction reuse, rollback/outbox. Demonstrate complete employee→agent→employee journey. No claims of production readiness.
