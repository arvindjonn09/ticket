# Astrama delivery status

See [Agent activity](#agent-activity) for delegated work, handoffs, questions, elapsed time, and reported token usage. For live sessions, use Claude Code's [`claude agents` view](https://claude.com/resources/articles/agent-view-in-claude-code) or Codex's IDE [background-agent panel](https://learn.chatgpt.com/docs/agent-configuration/subagents). The local GitHub Actions workflow runs build, tests, Playwright, dependency audit, and licence checks on pull requests and pushes to `main`; view runs on [this repository's Actions page](https://github.com/arvindjonn09/ticket/actions) after the workflow is pushed.

## Current local application delivery — 11 November 2026

This pass implements the remaining application and operator tooling. The previous delivery below is historical and its pending-feature list is superseded by this section. Actual customer hosting, DNS, trusted TLS, SMTP/offsite credentials and pilot acceptance remain external inputs; none has been invented or deployed.

- **Recovery and authentication:** same-origin password recovery with uniform encrypted request enqueue for known/unknown accounts, hashed one-use reset tokens, durable mail retries, MFA preservation and session revocation. Owner-only verified lost-MFA recovery and atomic offline rotation cover MFA, invitation, recovery-link and recovery-request ciphertext. Login/password-change throttles and CSV previews now persist in PostgreSQL across API instances.
- **Organisation policies:** business weekdays/holidays and approval reminders/escalation/automatic incident closure, disabled until enabled by an administrator; configurable scanned file limits/extensions; retention periods and legal holds. Owner tools export business data/private objects without credential material and preview/execute retention or full tenant deletion with durable object cleanup retries.
- **Operations:** database-aware API health, worker heartbeat, administrator service-health panel, generic operator alerts, production HTTPS Compose/nginx configuration, separate non-root read-only API/worker image, configuration preflight, full encrypted database/object/key backup tooling and scheduling helper. Runbooks: [production](production-deployment.md), [recovery](recovery.md), [automation](automation.md), [data lifecycle](data-lifecycle.md), [backups](backup-recovery.md).
- **Review corrections:** login revalidates email after a concurrent account change; blocked IPs cannot allocate arbitrary account-throttle rows; legal holds committed while deletion waits are observed before object removal; category/item corrections retain fallback routing alerts; sensitive destination notifications and exports recheck the current group. Backup cleanup cannot hide Docker inspection failure, and Windows backup permissions explicitly replace a permissive DACL.

### Verification for this pass

| Check | Evidence |
| --- | --- |
| API and service integration | **87 unique passing checks**: consolidated 84, new operational-health permissions/probes 2, and new routing/SMTP/CSV regression 1. After the final routing correction, all 14 request checks and all 5 launch-safety checks passed again. Real PostgreSQL, S3-compatible storage, ClamAV and SMTP were used; the queue restart/enqueue-window check ran with `RUN_QUEUE_TESTS=true`. |
| Fresh installation | **1 passed** on a new PostgreSQL 16 cluster without demo seed or pre-existing runtime role. All 16 migrations applied; repeated bootstrap, activation, RLS/runtime grants, auth and outbox verified. Generated cluster/volume removed. |
| Domain/frontend/scripts | **12 domain + 5 web + 3 script checks passed**. Script checks cover production configuration/parser and backup authentication, wrong keys, tampering, junction boundaries and explicit Windows ACL replacement. |
| Browser journeys | **18/18 passed** across Chromium, Firefox and WebKit: incident lifecycle, light/dark/mobile, QR MFA and routing setup, invitations/manager/VP fulfilment, real queued password recovery and signed-out view. Additional settings-panel Axe checks found an unstyled dark button; existing form/button styles were applied and all **3 focused browser reruns passed**. These reruns add assertions to existing journeys rather than three new unique tests. Automation, file/retention and health panels passed light/dark/mobile Axe checks; refreshed screenshots were inspected. |
| Production boundary | Disposable HTTPS rehearsal passed: preflight/Compose configuration, TLS health, HTTP redirect, HSTS/CSP/security headers, real fixture login with Secure/HttpOnly/SameSite=Strict cookie, UID 1000, read-only `/app`, no owner connection in runtime. Self-signed local TLS verifies wiring, not a real domain's certificate trust. All generated rehearsal resources removed. |
| Monitoring | Missing verified-backup heartbeat correctly failed the monitor and produced one generic alert in local Mailpit. Following the successful full restore, the operator check returned **healthy=true** for database, worker, storage, scanner, queue and backup. |
| Full backup/restore | Capture and isolated restore passed; a separate retained-backup restore also passed at **12:43:51 AEDT** after fixing PostgreSQL initialization readiness to use TCP. Verified **31 public tables**, byte hashes for **1 private object**, private unauthenticated denial and decryption of **2 MFA, 1 invitation, 1 recovery-link and 1 recovery-request** secrets. A temporary fixture exercises all four encrypted types and private storage. Source fixture and all generated restore containers/volumes/networks removed; live services healthy. Only five encrypted artifacts remain under the ignored `.local-backups/backup-2026-11-11T01-41-50-875Z-5de1b5b23f3e48c88a82e7eb9672bf97` directory. No offsite upload or recurring schedule was installed. |
| Build/static/dependencies | Final API/web and production-image builds, lint/typecheck and diff checks passed. Final production runtime imports Prisma/Argon2/API successfully as UID 1000, with source, `.env` and `.local-backups` excluded. Production dependency audit found no known vulnerabilities; 190-package production licence allowlist passed. Native Windows licence lookup lacked a pnpm store index, so the same licence check passed inside the built Docker image. |

**126 distinct automated checks passed** across the runs above; focused reruns are not double-counted. The separate HTTPS, alert and full-backup rehearsals supply additional operational evidence. CI was updated to include the new integration/script checks, production image and three-browser journeys, but has not been run on GitHub in this session.

The latest 100-account smoke used **20 concurrent requests**: 100 unique successful submissions and 100 permitted lists, with a cross-employee denial. Observed submit p50/p95 was **1,450/5,722 ms**, list p50/p95 **606/1,090 ms**, total **22.41 s**. This host sample ran alongside image compilation; it is not a production capacity guarantee, a detail-page benchmark or an SLA. The earlier concurrency-10 run is recorded below.

Automation defaults off and destructive retention requires explicit operator execution. A real organisation must select its own routing, staffing, approval rules, support calendar, retention and file policy. External integrations, SSO, automatic mailbox intake and support-hour SLA timers remain separately scoped later work. No GitHub CI run, production rollout, customer policy approval, offsite copy or business pilot sign-off is claimed.

## Historical local application delivery — 10 November 2026

The application now covers the employee, support, approver and organisation-administrator journeys. Historical first-slice notes below describe earlier checkpoints; this section supersedes their feature exclusions.

- **Organisation setup:** compact section selector, users/manual invitations/100-row CSV preview, account activation, managers and approval eligibility, groups and queue leads, categories/subcategories with inheritance or override, catalogue policies, branding/timezone/defaults and audited changes.
- **Tickets and approvals:** independent INC/SR numbering, caller-on-behalf for agents, requested-for users, cost/quantity, sequential manager/VP approvals, alternates, dated delegates, correction queues, approval invalidation after material edits, claim/lead assignment, triage, hold/resume, transfer, cancellation/duplicate links, resolution/fulfilment and protected public/internal conversations.
- **Files and delivery:** private S3-compatible RustFS storage, ClamAV scanning that fails closed, protected downloads, a 5 MiB/file and 10-file/50 MiB/ticket local limit, PostgreSQL outbox/pg-boss email delivery and encrypted invitation outbox with retry. Emails contain authenticated links rather than ticket text; SMTP acknowledgement ambiguity can still duplicate email.
- **Visibility:** permitted profile history, audit history, filters/search, internal resolution search, CSV exports and reports capped at 200 permitted records. Time metrics use elapsed calendar hours, not business hours or an SLA.
- **Operations:** explicit owner-only database bootstrap and new-organisation provision command, 11 ordered migrations, restricted runtime roles, local backup/restore script, OpenAPI at `/api/openapi.json`, and CI configuration. No claim is made that the locally updated CI workflow has run on GitHub.

Shared ownership/interfaces: core backend and schema in [completion-contract.md](completion-contract.md), users/settings in [users-contract.md](users-contract.md), operator procedures in [operations.md](operations.md). The root orchestrator owns shared infrastructure, notifications/files/reports, integration and delivery evidence.

### Verification and limits

Final local verification completed at **21:05 AEDT, 10 November 2026**:

| Check | Evidence |
| --- | --- |
| API, real PostgreSQL and service integrations | **54 unique checks passed** across the consolidated run and its focused correction rerun: requests 14, incidents 13, organisation 8, users 9, files/SMTP/queue/reports 4, provisioning 3, load 1, OpenAPI 1, MFA 1. The consolidated run exposed a Mailpit test assertion using whole-mailbox `total`; it was corrected to count the recipient-filtered messages and all 9 users tests passed on rerun. |
| Fresh installation | **1 passed**, on a separate disposable PostgreSQL 16 cluster with no runtime role or demo seed. Bootstrap is repeatable, safely handles quote/backslash passwords, applies migrations 001–011, provisions/activates an account and verifies runtime privileges/RLS/auth/outbox. Repeated after adding NOREPLICATION; generated container/network removed. |
| Domain and frontend | **10 domain + 5 web checks passed**. |
| Playwright | **5/5 passed**: incident public/internal lifecycle and tenant denial; light/dark/mobile; organisation/MFA/groups/subcategory routing; invitation plus manager/VP approval and fulfilment; signed-out view. Axe checks passed for tested light/dark pages. Desktop and mobile request screenshots inspected. |
| Build and static checks | Docker API/web builds, workspace lint/typecheck, `git diff --check` passed. Runtime image uses UID 1000 and contains neither `.env` nor `.local-backups`. |
| Dependencies | Production licence allowlist passed for 190 packages; production dependency audit reported no known vulnerabilities. The full development audit previously retained 4 moderate advisories and passed the high-severity gate. |
| Running stack | API/database/mail/scanner healthy; web/storage/worker running; private bucket initializer exited 0. HTTP `/api/health` returned `ok`; `/api/openapi.json` returned OpenAPI 3.1.0. |

**75 distinct automated checks** passed across these runs. Bootstrap is deliberately skipped by ordinary tests because it requires a fresh isolated cluster. The API suite runs files serially because its real global dispatcher can otherwise race another suite's fixture cleanup. Web tests ran natively: running the whole workspace suite inside the non-root API image hit Vite's root-owned temporary build directory, so API/service checks ran inside Docker and web checks ran in the workspace.

The latest 100-account HTTP smoke used concurrency 10: 100 successful submissions with unique numbers, 100 permitted lists and a cross-employee denial. Observed submit p50/p95 were 457/908 ms, list p50/p95 207/397 ms, total 12.10 s. This local sample is not a 100-simultaneous-user benchmark or SLA guarantee. The worker restart check re-enqueues the same committed event and verifies its existing delivery record is not sent again; this is not a claim of exactly-once SMTP.

A local database backup was restored into a disposable database, then that generated database was removed. The retained private dump contained 2 fictional tenants, 8 users, 17 tickets, 45 activities, 48 audits, 0 attachments and 9 migrations at the time of the snapshot. Subsequent migrations 010/011 are verified separately. This check does not restore attachment objects or encryption keys and is not a production disaster-recovery rehearsal. Dumps are excluded from Git and Docker build contexts.

Production work still pending: actual hosting/domain/HTTPS and mail configuration, supported-browser pilot, operational monitoring and recovery/key rotation, customer file/retention policy, complete database-plus-object recovery, business-calendar reminders/escalation/automatic closure, full tenant export/deletion and customer-specific external integrations. Proposed settings are not silently treated as agreed customer policy. Authentication throttling and CSV-preview storage are currently per API process; multi-replica deployment requires shared enforcement/storage. Primary roles remain employee/agent/admin with separate approval eligibility and group leadership, rather than arbitrary role combinations.

## Agent activity

### Remaining application and launch tooling — 11 November 2026

User instruction: implement all remaining work. External hosting/domain/mail details requested while local implementation continues. No production deployment or destructive action on existing customer organisations is implied by fixture verification.

| Task | Agent / model | Status | Started (AEDT) | Finished / elapsed | Tokens | Ownership / handoff |
| --- | --- | --- | --- | --- | --- | --- |
| Recovery, shared login limits and key rotation | recovery / gpt-6.1-sol high | Complete | 2026-11-11 12:03 | 12:25 / 22 min | Not reported | Auth, recovery backend/UI, migrations 012/016, four-type rotation; 20 focused checks passed. Independent review closed email-change login race and uniform encrypted recovery enqueue. Root integrated routes/worker. |
| Business-day automation | automation / gpt-6.1-sol high | Complete | 2026-11-11 12:03 | Complete by 12:12 / exact handoff not captured | Not reported | Calendar, settings/backend/UI and migration 013; 5 database + 12 domain checks passed. Root integrated current-recipient checks. Continued as backup author. |
| Data lifecycle and attachment policies | data_lifecycle / gpt-6.1-sol high | Complete | 2026-11-11 12:03 | Complete by 12:22 / exact handoff not captured | Not reported | Policy UI/API, owner export/retention/delete and migration 014; 6 database/storage checks passed. Independent review exposed legal-hold snapshot race; author fixed and added deterministic regression. |
| Deployment, monitoring, complete recovery and integration | Primary orchestrator | Complete for local application/tooling | 2026-11-11 12:03 | Integrated by 12:45 / 42 min including verification and waits | Not reported | Shared CSV previews/015, wiring, infrastructure, production image/runbook/CI, 126 distinct checks and operational rehearsals. Actual hosting/domain/mail/offsite inputs requested asynchronously; no reply, so real deployment remains unconfigured. |
| Encrypted complete backup and isolated restore | automation / gpt-6.1-sol high | Complete | 2026-11-11 12:12 | 12:43:51 / 31 min 51 sec including coordinated standby | Not reported | Full encrypted capture/restore and independent retained restore passed. Corrected TCP readiness after a temporary PostgreSQL init-server race. All isolated resources/source fixture removed, live backup heartbeat healthy, private key retained without disclosure. Schedule/offsite activation belongs to deployment. |
| Fresh installation, health permissions and acceptance review | recovery / gpt-6.1-sol high | Complete | 2026-11-11 12:25 | Complete by 12:37 / exact handoff times above | Not reported | Fresh 16-migration install: 1 passed; health permissions/probes: 2 passed. Acceptance review found missing correction fallback-alert flags; author fixed both paths, and requests 14 + launch-safety 5 passed. Destination/old-group SMTP, sensitive CSV and generic admin alerts covered. |
| Backup/production review, HTTPS and new-panel QA | data_lifecycle / gpt-6.1-sol high | Complete | Follow-up time not captured | Visual review complete by 12:40; root browser rerun 12:41 | Not reported | Backup author fixed cleanup, ACLs and image paths. Reviewer fixed preflight hostname/TLS/parser checks; disposable HTTPS/cookies/headers/read-only runtime passed and fixtures removed. New panel Axe exposed styling/contrast issue; existing form/button classes fixed it, all 3 browsers passed and refreshed screenshots were inspected. |

Prior delivery evidence below is historical until this pass has completed its verification. Handoffs have agreed SQL-only new tables to avoid conflicting Prisma schema edits; runtime tenant policies and grants remain mandatory. Agents coordinate foreign-key cleanup with the lifecycle owner. Runtime token counts are unavailable unless explicitly reported.

### Application completion work — 10 November 2026

| Task | Agent / model | Status | Started (AEDT) | Finished | Elapsed | Tokens | Handoff / questions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Service requests, approvals and ticket controls | complete_backend / gpt-6.1-sol high | Complete | 2026-11-10 20:12 | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | Schema/migrations 004/008/009, domain/contracts, requests/tickets, OpenAPI and 100-account smoke. Root integration verified; no unresolved contract question. |
| Application interface | complete_frontend / gpt-6.1-sol medium | Complete | 2026-11-10 20:12 | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | Web forms, approvals/users/admin controls, files/reports/history, light/dark/mobile and safe tenant formatting. Shared contracts supplied by backend/users; no open question. |
| Users, invitations and settings | complete_users / gpt-6.1-sol high | Complete | 2026-11-10 20:12 | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | Users/settings contracts and backend, encrypted invitations, CSV preview, lifecycle protections, provisioning and operations. Follow-up review fixes revalidate session/MFA and manager-change approvals. |
| Attachments, notifications, integration and verification | Primary orchestrator | Complete for local scope | 2026-11-10 20:12 | 2026-11-10 21:05 | 53 min wall-clock, including agent waits | Not reported | Infrastructure, wiring, private storage/scanning, pg-boss delivery, reports, end-to-end checks, migration 011 and delivery evidence above. Production scope remains explicit. |
| Clean installation and runtime grants | complete_users / gpt-6.1-sol high | Complete | 2026-11-10 20:49 | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | New bootstrap/010 grants work without demo seed; isolated fresh-cluster check passed. Root supplied 011 dispatcher policy and final image. Question: migration ownership; resolved as 010 worker/011 root. |
| Composer send race | complete_frontend / gpt-6.1-sol medium | Complete | 2026-11-10 20:56 | Handoff time not captured; verified by 21:05 | Not reported | Not reported | Guarded draft clear and disabled editing/audience changes during send. Incident public-message/internal-note browser regression passed without delays. |
| Invitation dispatch and fixture concurrency | complete_users / gpt-6.1-sol high | Complete | 2026-11-10 20:56 | Handoff time not captured; verified by 21:05 | Not reported | Not reported | Conditional updates tolerate deleted invitation rows; unavailable tenant skips delivery. Real PostgreSQL/TCP race check passed. Root serialized integration files and corrected Mailpit recipient assertion; users 9/9 passed. |
| Provisioning, restore and bounded security review | complete_users / gpt-6.1-sol high | Complete | Follow-up start not captured | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | Provision command/tests and operations guide, isolated DB restore, review of auth/users/requests/files/notification boundaries. Concrete session/manager/invitation findings fixed; bounded review is not a penetration test or production approval. |
| API specification and company smoke | complete_backend / gpt-6.1-sol high | Complete | Follow-up start not captured | Handoff time not captured; integrated by 21:05 | Not reported | Not reported | Added OpenAPI controller/check and 100-account bounded-concurrency HTTP smoke; root registered controller and reran checks. No capacity guarantee inferred. |

This work targets the remaining local application workflows in plan phases 2–4. Production hosting, customer retention/attachment policies, support-hour/SLA commitments, production secrets, commercial service licensing, and pilot sign-off still require deployment-specific decisions and evidence. Later integrations and a generic plugin/workflow engine are not part of this build.

The orchestrator adds a row when an agent starts and updates it when the result or handoff arrives. Times use Australia/Sydney. `Not reported` means the runtime did not provide a measurement; do not estimate token counts or elapsed time. Keep work summaries short and include changed files/checks where relevant. Record questions asked by an agent and their answer or current owner so blockers remain visible.

| Task | Agent / role | Status | Started | Finished | Elapsed | Tokens | Work completed / result | Handoff to | Questions and answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Add agent visibility and handoff log | Primary agent / orchestrator | Complete | Not captured | 2026-11-10 01:23 AEDT | Not reported | Not reported | Added IDE activity link and durable task/handoff/question log; updated orchestration instructions. | None | User confirmed AI coding agents; no open question. |
| Complete workspace and local infrastructure slice | DevOps engineer | Complete | 2026-11-10 01:32 AEDT | 2026-11-10 01:56 AEDT | 24 min | Not reported | Added GitHub CI, production licence check, and non-root API image. Compose config/build, lint, typecheck, build, and 21 unit/integration tests passed; signed-out Playwright passed 1/1. Signed-in E2E needs the frontend session fix below. | Frontend engineer (login flow) | No agent questions. |
| Patch critical test-runner audit findings | DevOps engineer | Complete | 2026-11-10 01:58 AEDT | 2026-11-10 02:06 AEDT | 9 min | Not reported | Pinned Tinypool 2.1.2 with Vitest 3.2.7. Frozen lockfile install, dependency resolution, and all 21 tests passed; high-severity audit exits 0. Four moderate advisories remain. | Backend engineer | No agent questions. |
| Audit and complete backend incident slice | Backend engineer | Complete; no code changes needed | 2026-11-10 02:07 AEDT | 2026-11-10 02:14 AEDT | 7 min | Not reported | No concrete backend gap found. PostgreSQL integration 13/13, domain 6/6, web API unit 1/1 passed. Root test command initially skipped integration for missing `MIGRATION_DATABASE_URL`; the DB suite was rerun with it configured. | Frontend engineer (signed-in Playwright failure) | No agent questions. |
| Verify signed-in session transition | Frontend engineer | Complete; no source change needed | 2026-11-10 02:14 AEDT | 2026-11-10 02:28 AEDT | 14 min | Not reported | Rebuilt current web image; web unit tests 2/2 and Playwright 3/3 pass. Login reaches Incidents immediately without reload. Earlier failure used a stale Compose web image; current source already updates the session observer and clears account-scoped cache. | Orchestrator | No agent questions. |

Completed implementation handoffs (start/finish times were not captured by the orchestrator; token usage was not supplied):

| Task | Agent / role | Status | Started | Finished | Elapsed | Tokens | Work completed / result | Handoff to | Questions and answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Incident backend | build_backend / backend and data | Complete | Not captured | 10 November 2026; time not captured | Not reported | Not reported | API, schema, migrations, seed, shared contracts/domain; 6 domain and 13 database tests passed. | Orchestrator and security reviewer | Proxy/login-limit and CSRF findings resolved before final review. |
| Incident interface | build_frontend / frontend | Complete | Not captured | 10 November 2026; time not captured | Not reported | Not reported | Employee/agent UI and themes; fixed session observer/cache isolation and added regression check. | Orchestrator | Browser-discovered login issue fixed; no open question. |
| Independent security review | slice_security_review / security | Complete | Not captured | 10 November 2026; time not captured | Not reported | Not reported | Reviewed final isolation/auth/concurrency/outbox implementation; approved bounded local slice. | Orchestrator | All concrete review findings resolved; later features remain out of scope. |

The implementation handoffs below are retained from a separate recorded session. This orchestration pass is independently rechecking the current tree and updating status as each plan task is completed.

## Completed foundation: local incident workflow

| Task | Owner / requested model | State | Scope |
| --- | --- | --- | --- |
| Record confirmed direction and fix moved instruction links | Orchestrator | Complete | Branding, themes, organisation-owned approval and integration policies. |
| Workspace and local infrastructure | DevOps engineer | Complete | Frozen-lockfile Docker build, CI, migrations, seed, health checks, licence gate, non-root API image, Tinypool patch; high-severity audit passes. |
| API, schema, domain and database tests | Backend engineer | Complete | 6 domain and 13 PostgreSQL integration tests passed; current slice review found no additional backend gap. |
| Employee and agent interface | Frontend engineer | Complete | Current-source web unit tests 2/2; Playwright 3/3. Login transitions without reload; no source change was needed. |
| Integrated checks and independent review | Orchestrator + security reviewer | Complete for this local slice | Compose build/startup, lint, typecheck, build, 21 unit/integration tests, Playwright 3/3, high-severity audit, and licence check passed. Prior independent security review covers the agreed bounded slice; backend re-audit found no new gap. Four moderate advisories remain. |

Runtime token usage is not reported here unless supplied by the runtime. The organisation setup milestone below extends this foundation with admin MFA and configuration. Approvals, attachments, notification dispatch, integrations, and production rollout remain later slices. No production-readiness claim.

## Verification recorded 10 November 2026

The local demo is running at http://localhost:4310. Login instructions are in [README.md](../README.md#run-the-local-demo).

| Check | Result and scope |
| --- | --- |
| Docker build and startup | Passed; migrations and seed applied, PostgreSQL/API healthy, nginx serving the application. |
| Workspace lint and TypeScript | Passed across API, web, domain and contracts. |
| Domain tests | 6 passed: incident transitions and permissions. |
| PostgreSQL integration | 13 passed: authenticated incident flow, isolation, sensitive-group permissions, internal content filtering, CSRF, sessions, login throttling, numbering, idempotency, concurrent claims, RLS and atomic audit/outbox rollback. Executed by backend worker. |
| Web unit tests | 2 passed: HTTP boundary and login/logout cache isolation, including cancellation of old account requests. |
| Playwright | 3 passed: complete employee/agent journey, same-browser organisation switch, foreign-tenant denial, signed-out page, light/dark checks and mobile form layout. |
| Accessibility and visual inspection | Axe reported no violations for the tested light/dark incident lists after fixing secondary text contrast. Light/dark desktop and 390px mobile form screenshots inspected. This is not a complete WCAG audit. |
| Dependency checks | Production dependency audit reported zero known vulnerabilities and the production licence inventory matched allowed licence families. The full development dependency audit passes the high-severity gate; four moderate advisories remain. |
| Security review | Independent source review approved the agreed local slice after login-limit/proxy and CSRF fixes; reviewer did not independently rerun the integration suite. |

Those first-slice results covered the incident subset of plan section 13. Organisation administration is verified separately below. Service-request, approver/delegate, attachment, email-delivery, recovery and 100-user pilot criteria remain unverified and unchecked. Sensitive transfer/export paths and job-worker retries are not implemented yet. The outbox stores events but does not send notifications. Password-login throttling currently operates within one API process.

Next product work after organisation setup: user onboarding/lifecycle and service requests with organisation-configured approval policies. Full production MFA recovery and key rotation need an operational process before launch.

## Organisation setup implementation

| Task | Agent | Status | Started (AEDT) | Completion recorded (AEDT) | Elapsed | Tokens | Result / handoff | Questions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Groups, categories, subcategories and MFA API | org_backend / Sol high | Complete | 2026-11-10 10:51 | 2026-11-10 11:07 | Not reported | Not reported | Migration 003, MFA, config API, routing; 22 API and 7 domain tests passed. Handoff to orchestrator. | User confirmed subcategory override with inheritance. |
| Organisation setup interface | org_frontend / Sol medium | Complete | 2026-11-10 10:51 | 2026-11-10 11:07 | Not reported | Not reported | MFA enrolment, admin forms, preview and incident subcategories; lint/typecheck and 3 web tests passed. Follow-up corrected checkbox layout and fallback wording. | Shared contract in organisation-slice.md. |
| Independent organisation security review | org_security / Sol high | Approved bounded slice | 2026-11-10 10:55 | 2026-11-10 11:07 | Not reported | Not reported | Read-only review; independent RFC/TOTP/GCM checks passed. Parent-restore/archived-override finding fixed and regression passed. | No open finding. |

### Organisation setup verification

- Migration `202611100003_organisation_setup` applied without replacing existing tickets. Seed provisions demo administrators without resetting enrolled MFA.
- **22 API tests passed:** 13 existing incident integration tests, 8 new organisation integration tests and one RFC-vector crypto test. **7 domain tests** and **3 web tests** passed. Database tests use real PostgreSQL and the restricted runtime role.
- New database coverage: restricted admin sessions, enrolment-session binding, consumed-code rejection and persistent MFA lockout; non-admin and other-tenant denial; CSRF; group/member validation; inherited and overridden routing; parent/subcategory constraints; archival, unused deletion and revisions; configuration audit; historical routing; claim/member-removal concurrency; parent restore with an archived override destination.
- The new real-browser journey passed: enrol a temporary admin, create two groups and members, create category/subcategories, preview both destinations, submit incidents, verify group claim permissions, change the default mapping without moving old tickets, and archive a used subcategory. Light/dark Axe checks and 390px horizontal-overflow checks passed. Existing three Playwright journeys also passed. The first organisation attempt exposed an overly strict test selector; the corrected selector passed without changing application routing.
- Full workspace lint/typecheck and Docker build passed. Final API/web images are running with healthy services. Combined Playwright run passed **4/4** in 34 seconds: **36 automated tests total** across API, domain, web and browser suites. Light/dark desktop and mobile screenshots were inspected; screenshot capture starts at the top to avoid full-page fixed-sidebar capture artifacts.
- No dependencies added. CI now generates a disposable MFA encryption key and builds shared packages before typechecking a clean checkout.

Boundaries: one department is one support group; members are selected from existing active agents. Organisation provisioning/user invitations, self-service MFA recovery, production key rotation, full requests/approvals and notification delivery remain separate work. A per-tenant configuration lock currently serializes ticket operations to protect routing and membership consistency; 100-user load performance has not been established.

### Authenticator QR setup — 10 November 2026

Implemented by the primary agent: local QR rendering using `qrcode.react` (ISC), collapsible manual-key fallback, black-on-white QR with four-module margin in both themes, responsive sizing and translated scan instructions. No API, MFA policy, credentials or enrolment records changed. The web container was rebuilt and updated.

Validation: web build/typecheck, workspace lint, 3 web unit tests, production licence gate and production dependency audit passed (no known vulnerabilities reported). The organisation Playwright journey passed with an independent `jsqr` decoder (Apache-2.0, test-only): decode the actual rendered QR in light/dark mobile views, compare with manual details, assert no external requests, and use the decoded secret to complete MFA verification. Mobile layout and Axe checks passed; screenshot inspected. Test accounts were isolated and removed.

### Compact organisation setup — 10 November 2026

Implemented by the primary agent: a native **Manage section** dropdown selects Support groups, Categories, Subcategories or Routing preview. Only the selected panel is visible; panels stay mounted so unfinished entries survive section changes. The selector stays available while scrolling, and long group-member lists have a bounded height. No dependencies added.

Validation: web build/typecheck, workspace lint, Docker web build and the focused organisation Playwright journey passed. Browser coverage includes draft text/member selection preservation, category and subcategory routing, one visible panel at a time on mobile, horizontal overflow and Axe checks. Desktop/mobile screenshots inspected. The local database and API had stopped before verification; services were restarted, including the Compose setup migration/seed dependency, and the updated web container is running at http://localhost:4310.
