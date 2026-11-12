# Claude review → Codex handoff — 12 November 2026 (rev. 2, owner decisions included)

Reviewer: Claude (analysis only; no code changed). Implementer: Codex orchestrator. Codex commits and pushes after CI is green.
Basis: working tree as of 12 Nov 2026, `origin/main` = `22470ed` (plan + agent briefs only). Packets use the format in [orchestrator.md](../../.claude/agents/orchestrator.md#dispatch-and-reporting).

## Owner decisions — answered 12 November 2026

Record these in `update-plan.md` §24 as **confirmed** (CX-06).

| #   | Question             | Owner answer                                                                                                                                                                                                                                                   | Consequence for implementation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Agent read scope     | Category routes the ticket to a department; all members of that department's group see and work it. If it is not resolved there, they can move it to another department. **Anyone who belongs to any department group can look up the details of any ticket.** | Keep current broad read for group members. Tighten: read access requires _active membership of at least one active group_, not just `role === 'agent'`. Work actions (claim, notes, resolve) stay limited to the owning group. Any group member may transfer with a reason. Sensitive (Security) tickets stay restricted per plan §3 (owner did not change this; confirm in pilot). Because every agent can read every ticket, **agent MFA is required** (CX-03). |
| D2  | Email setup          | Configure the real mailbox at the final production step. Until then use **smoke emails and a smoke organisation** for testing.                                                                                                                                 | Build CX-04 behind an adapter with a local/test adapter (Mailpit + signed test webhook) and a seeded smoke tenant. No real provider, DNS or credentials during build.                                                                                                                                                                                                                                                                                             |
| D3  | SLA clock on hold    | **The clock does not pause** while On Hold.                                                                                                                                                                                                                    | SLA elapsed time runs through every non-terminal state. Targets per priority are not yet given → ship admin-configurable targets with clearly marked proposed defaults (CX-05).                                                                                                                                                                                                                                                                                   |
| D4  | Deployment model     | After the build is finished and published, the Docker stack moves to **another machine and runs without agents**.                                                                                                                                              | Production must be self-operating: published images, documented install/upgrade/rollback, scheduled backups, health alerts, log rotation (new CX-07).                                                                                                                                                                                                                                                                                                             |
| D5  | Email and misrouting | Emailed tickets arrive without a category, and misrouted tickets slow down resolution.                                                                                                                                                                         | Route email by **department addresses** (admin-mapped like categories) with a general address → triage. Triage gets an alert and its own SLA target. Auto-reply invites the sender to choose a category in the portal (CX-04).                                                                                                                                                                                                                                    |

## Status since the 11 Nov review

| Item                                                                                  | Status                          |
| ------------------------------------------------------------------------------------- | ------------------------------- |
| Business-day reminders, escalation, auto-close (`automation.ts`, disabled by default) | Done                            |
| Account recovery, MFA key rotation, data lifecycle, operator data tools               | Done locally                    |
| Hardened production compose, stack backup incl. objects                               | Done locally                    |
| **Work committed / CI run on GitHub**                                                 | **Open — highest risk** (CX-01) |
| Formatting / file size / module structure                                             | Open (CX-02)                    |
| MFA for agents                                                                        | Open (CX-03)                    |
| Email-to-ticket                                                                       | Open (CX-04)                    |
| SLA targets                                                                           | Open (CX-05)                    |
| Plan/agent-brief accuracy                                                             | Open (CX-06)                    |
| Self-running production handover                                                      | Open (CX-07)                    |

Order: **CX-01 → CX-02 → CX-06 → CX-03 → CX-04 → CX-05 → CX-07**. CX-07 runs last because it packages the finished product.

---

## CX-01 — Commit safely, with no sensitive information (P0)

```text
Task ID / outcome: CX-01 — all local work on GitHub, green CI, provably no secrets or real data in Git history.
Role / model: orchestrator / gpt-6.1-sol / medium.
Files allowed to edit: .gitignore, .dockerignore, .github/workflows/ci.yml, new .gitleaks.toml, test fixtures only if they contain secrets.
Excluded (must never be staged): .env, .env.* except *.example, .local-backups/, *.dump, *.sql dumps, test-results/, playwright-report/, any key/cert file.

Steps:
 1. Branch: `git switch -c feat/local-application` (never commit straight to main).
 2. Ignore check: `git check-ignore -v .env .local-backups/<file>.dump` must report a rule for each; add `*.dump`, `*.pem`, `*.key`, `*.p12`, `secrets/` to .gitignore if missing.
 3. Secret scan BEFORE the first commit: run gitleaks (MIT) on the working tree (`gitleaks dir .`); fix or allowlist only clearly fake CI/demo values (e.g. ci-app-password) with a comment.
 4. .env.example / .env.production.example: placeholders only (`change-me`), no real hosts, emails or keys.
 5. Seed/fixture review: fictional names and example.com/example.org addresses only; no real employee data.
 6. Stage by area, never `git add -A` blindly; review `git diff --cached --stat` each time. Suggested commits:
    infra+CI · schema+migrations · domain+contracts · api · web · e2e/tests · scripts · docs/plan/agents.
 7. CI: add a gitleaks job on every push/PR (fails the build on a finding). Enable GitHub secret scanning + push protection in repo settings (owner action, free for public repos).
 8. Push branch, open PR, CI green on GitHub, merge to main.

Acceptance: gitleaks clean on tree and on full history; PR CI green (link in report); `git ls-files | grep -E '\.env$|\.dump$|local-backups'` returns nothing.
Stop/escalate when: a real secret is found (rotate it first — removing it from Git is not enough), or a dump is already in history.
```

## CX-02 — Long-term code structure and formatting (P0, behaviour-neutral)

Owner asked for the best long-term approach. Recommendation:

1. **Formatting is automatic, not negotiated:** Prettier (printWidth 100) + ESLint, both checked in CI; pre-commit hook optional. One formatting-only commit for the whole repo.
2. **Feature folders, not flat files.** API: one NestJS module per business area — `apps/api/src/modules/{tickets,requests,approvals,routing,users,organisation,attachments,notifications,inbound-mail,automation,reports,auth}/` each with `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.test.ts`. Web: `apps/web/src/workspaces/{employee,support,approver,admin}/` + `shared/`. `main.tsx` becomes bootstrap/routing only.
3. **Business rules move into `packages/domain`** as they are touched (state machines, approval evaluation, SLA calculation, routing). Services orchestrate I/O only. This is what keeps the "change framework or UI later" promise real.
4. **Size limits:** ESLint `max-lines` 400 per file, `complexity` warning at 15. Large files must be split when next edited.
5. **Ponytail scope rule:** apply ponytail to scope and dependencies (YAGNI); readability is never traded for fewer lines.
6. **Supporting practice:** Dependabot (or Renovate) weekly updates, ADR for every structural decision in `docs/adr/`, conventional commit messages.

```text
Task ID / outcome: CX-02 — structure and formatting above, with zero behaviour change.
Role / model: devops-engineer (tooling) then backend + frontend (moves) / gpt-6.1-sol / medium.
Dependencies: CX-01 merged.
Acceptance:
  - Separate commits: (a) tooling config, (b) formatting only, (c) API module moves, (d) web workspace split.
  - Commit (b) is whitespace/line-break only (`git diff -w` shows no logic change).
  - Moves (c)/(d) are pure relocations + imports; all unit, integration and Playwright tests pass unchanged.
  - CI runs `format:check`, lint with new rules (max-lines as warn initially), typecheck, tests.
  - AGENTS.md ponytail rule amended as in point 5; ADR 003 records the module layout.
Stop/escalate when: a move requires changing an API contract or database schema.
```

## CX-03 — Agent access per D1, with agent MFA (P1, security)

```text
Task ID / outcome: CX-03 — implement D1 exactly and require MFA for all support agents.
Role / model: backend + frontend, security-reviewer gate / gpt-6.1-sol / high.
Dependencies: CX-02.
Inputs: tickets.ts:23 enforces MFA only for admins; canReadTicket currently allows any role==='agent'.
Acceptance:
  - Read: any user with active membership in ≥1 active group can view any non-sensitive ticket in the tenant (search, detail, profile history). Agents with no active group: no cross-ticket read.
  - Work (claim, internal note, resolve, fulfil, change classification): only members of the ticket's current group (queue lead may assign within group).
  - Transfer: any member of the current group can move an unresolved ticket to another active department with a required reason; audited; destination group notified; assignee cleared if not in the new group.
  - Sensitive tickets: unchanged — restricted group only (confirm in pilot).
  - MFA: tenant setting requireAgentMfa default ON; enforced once in the session/policy guard (remove the per-service admin check duplication). Existing agents are prompted to enrol at next sign-in.
  - Tests: member of other group can read but not claim/note; member removed from all groups loses read; transfer audited and notified; agent without MFA denied everything except enrolment; other tenant unaffected.
  - Security-reviewer approval recorded in task-status.md.
```

## CX-04 — Email-to-ticket with department addresses (P1)

### Design (incorporates D2 and D5)

- **Adapter boundary:** `InboundMailAdapter` → normalised `InboundMessage {tenantId, messageId, inReplyTo, references, from, to, subject, text, html, attachments[], authResults}`.
  - Build now: `TestInboundAdapter` (signed local webhook used by smoke tests and a dev script that posts `.eml` files) + Mailpit for outbound.
  - Production step later: a provider webhook adapter or a Microsoft Graph / Gmail API mailbox adapter, chosen when the mailbox is set up. No IMAP basic auth.
- **Addresses and routing (fixes misrouting delay):**
  - Admin maps **inbound addresses → department group**, managed like category mappings (e.g. `it@` → IT Support, `apps@` → Application Support, `security@` → Security, restricted). Validation: destination active with active members, otherwise triage.
  - A **general address** (`help@`) → Service Desk Triage.
  - Each new emailed ticket: Incident, Channel = Email, category = "Not sure / General help" (or the mapped department's default category), Untriaged flag.
  - **Triage alert + triage SLA:** the triage queue owner is notified immediately; triage has its own first-touch target in CX-05, so unclassified email cannot sit unseen.
  - **Auto-reply** to the sender: ticket number + link to the portal page where they can choose the category, which reroutes it. Link-only, no ticket content.
  - Agents fix misroutes with the D1 transfer (reason required, audited).
- **Ingest pipeline (existing outbox/worker model):** webhook verifies HMAC, stores a tenant-scoped `inbound_message` row idempotent on `(tenant_id, message_id)`, returns 2xx fast; worker processes in a tenant-scoped transaction: loop checks → sender lookup → correlate or create → audit → outbox.
- **Tenant resolution:** from the recipient address only, never from message content.
- **Reply correlation:** per-ticket reply token in Reply-To (`help+t.<random token, stored hashed>@…`) → `In-Reply-To`/`References` of messages we sent → `[INC0001]` subject tag only if the sender is already a participant. Otherwise a new ticket.
- **Sender trust:** require provider-reported DMARC/SPF/DKIM pass for the company domain; failures go to triage as `unverified-sender` with no notification to the claimed user. Unknown senders (not active users in the tenant): no ticket by default; tenant setting may allow "triage, unverified". Email never grants access to a ticket the sender cannot already see.
- **Loop/flood prevention:** drop `Auto-Submitted: auto-*`, `Precedence: bulk|auto_reply`, our own From/Message-IDs; record bounces against the delivery row; per-sender rate limit (e.g. 20/hour) stored in the database.
- **Content:** store text; sanitise HTML server-side (allowlist) and render as text by default; collapse quoted history for display while keeping the original. Attachments use the existing scan pipeline and limits. Email posts are always `audience = customer`, never internal notes.
- **Outbound:** stays link-only; add Reply-To token and `Message-ID`/`References` headers so replies thread.
- **Smoke organisation:** seed a `smoke` tenant with fictional users, department addresses on a reserved test domain (e.g. `smoke.example.test`), used by CI and the final pre-production smoke run.

```text
Task ID / outcome: CX-04 — employees create and reply to tickets by email; department addresses reduce misrouting; tested end to end with smoke emails/organisation only.
Role / model: product-analyst spec (docs/specs/email-intake.md from this design) → data-engineer (inbound_message, address mappings, reply tokens, sender-rate table, RLS) → backend (adapter, webhook, worker) → frontend (admin address mapping, "via email" badge, choose-category page) → security-reviewer gate. gpt-6.1-sol / high.
Dependencies: CX-03 (transfer + read rules), CX-02 module layout (new module inbound-mail/).
Acceptance (real PostgreSQL + Mailpit + smoke tenant):
  - it@ → IT Support queue; help@ → triage + triage owner alerted; unmapped/inactive address → triage with routing exception.
  - Sender picks category via auto-reply link → ticket rerouted and audited.
  - Same Message-ID twice → one ticket/message.
  - Reply via token → customer message on the correct ticket; other tenant's/ticket's token rejected.
  - Auto-reply / bounce / own message → no ticket, no notification.
  - DMARC fail → triage unverified, claimed user not notified.
  - Unknown sender (default) → no ticket; setting on → triage unverified.
  - Subject tag from a non-participant cannot append to that ticket.
  - Reply to Complete/Cancelled/Rejected ticket → new linked ticket.
  - Infected attachment quarantined, message kept.
  - Tenant A address never creates data in tenant B.
Stop/escalate when: anything requires a real provider account, DNS or production credentials (deferred to the production step per D2).
```

## CX-05 — SLA clocks, no pause on hold (P1)

```text
Task ID / outcome: CX-05 — first-response and resolution targets per priority, visible in queues and reports; clock never pauses (D3).
Role / model: product-analyst spec → data + backend → frontend / gpt-6.1-sol / medium-high.
Acceptance:
  - Admin-configurable per tenant per priority: first-response target, resolution target, calendar = business hours or 24x7. Proposed defaults, labelled "proposed" in the UI until the owner confirms:
      P1 1h / 4h (24x7) · P2 4h / 1 business day · P3 1 / 3 business days · P4 2 / 5 business days · P5 5 / 20 business days.
  - Triage first-touch target (D5), proposed 1 business hour.
  - Target snapshot on the ticket at creation/priority change (like routing); config changes affect new tickets only; priority change recalculates with an audit reason.
  - Clock runs in every non-terminal state including On Hold (D3); stops at Resolved for resolution, restarts on reopen ("Still a problem").
  - First response = first customer-visible agent message (plan §19), not automated mail or auto-replies.
  - Business-hour maths in packages/domain (extend elapsedBusinessDays to hours, tenant timezone, holidays); fixed-clock tests across weekend, holiday, DST change, hold, reopen.
  - Warning at 75% and breach notifications via the existing worker, idempotent per ticket/target.
  - Queue column "time to breach"; reports: % met by department and priority.
```

## CX-06 — Documentation and agent-brief tidy (owner approved)

```text
Task ID / outcome: CX-06 — plan and briefs match code, decisions D1–D5 recorded.
Files allowed to edit: update-plan.md, CLAUDE.md, AGENTS.md, .claude/agents/*.md, docs/task-status.md, docs/history/.
Acceptance:
  - update-plan.md §24: record D1–D5 as confirmed 12 Nov 2026; correct "Remaining launch design" (automation, recovery, key rotation exist); §14 mark answered items.
  - Merge .claude/agents/AGENTS.md into root AGENTS.md; delete the duplicate.
  - orchestrator.md model table: add a Claude column (opus: data/backend/security; sonnet: frontend/devops/QA; haiku: mechanical).
  - Every task packet template gains: "feature branch; push only after CI green; no secrets (gitleaks)".
  - New brief .claude/agents/integration-engineer.md: inbound/outbound mail, future SSO, Teams/Slack, webhooks; adapters; tenant-scoped encrypted secrets; signed webhooks; smoke-tenant testing.
  - docs/task-status.md: move dated history to docs/history/2026-11.md; keep a one-page current status.
```

## CX-07 — Self-running production handover (P1, last)

Per D4 the stack will run on another machine without agents, so it must operate and recover on its own.

```text
Task ID / outcome: CX-07 — a person with Docker but no agents can install, run, back up, upgrade, roll back and monitor Astrama.
Role / model: devops-engineer, security-reviewer gate / gpt-6.1-sol / medium-high.
Acceptance:
  - Images: CI builds and publishes versioned images (e.g. GHCR, tag = release version + git SHA) on a release tag; target machine pulls, never builds. Release notes per version.
  - Install: one `docs/install.md` — prerequisites, copy compose.production.yaml + .env.production (from example), generate secrets with a provided script, first-admin provisioning, HTTPS (reverse proxy with automatic certificates, e.g. Caddy) — tested on a clean VM.
  - Secrets live only on the target machine (file permissions 600); nothing secret in images or Git.
  - Backups: scheduled (cron/systemd timer or a backup container) database + attachments + key material, encrypted, retained N days, copied off the machine; restore drill documented and tested on a second clean VM.
  - Upgrade: `docs/upgrade.md` — backup → pull new tag → migrate (setup service) → start; rollback = previous tag + restore if a migration is not backward-compatible (state per release).
  - Monitoring without agents: health endpoints + an external uptime check; email alert to the owner on failed jobs, failed backups, backup age > 26h, disk > 80%, certificate expiry < 14 days.
  - Logs: Docker log rotation (max-size/max-file) configured; no ticket content in logs.
  - Time sync and timezone documented (SLA and automation depend on it).
  - Final pre-production smoke: run the smoke organisation and smoke emails (D2) on the target machine, then remove or disable the smoke tenant before real users are invited.
```

## Backlog after the pilot (P2 — needed to sell)

SSO (Entra ID / Google, OIDC first) · employee knowledge base from reviewed resolutions · Teams/Slack notifications · one-click CSAT · canned replies per group · API tokens + signed outbound webhooks · tenant self-signup and billing · external penetration test · DPA / privacy terms / security page · multi-replica readiness (confirm login throttling and CSV preview are database-backed; replace the per-tenant advisory lock in `database.ts` with finer locks if pilot load shows contention).

Later differentiator: opt-in AI assistance per tenant (summaries, category suggestion for emailed tickets, reply drafts, similar past resolutions), always human-approved, never exposing internal content to customers.
