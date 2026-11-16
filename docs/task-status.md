# Astrama delivery status

Status updated 16 November 2026. Detailed dated delivery records are in [November history](history/2026-11.md).

## Current position

- **CX-01 — secure source control:** feature branch is pushed and PR #1 was merged after CI passed. The repository is still public; CR-01 remains an owner action.
- **CX-02 — structure and formatting:** implemented on `feat/structure-formatting` in separate tooling, formatting, API-move, and web-split commits. API and web code typecheck after relocation.
- **CX-06 — plan and agent briefs:** complete. D1–D5 are recorded as confirmed, the historical status is in `docs/history/2026-11.md`, and the integration engineer brief/model mapping are in place.
- **CX-03 — agent access and MFA:** implementation committed. Focused domain, request, incident, launch-safety and organisation integration checks passed on isolated PostgreSQL; full API suite and final CI remain pending.
- **CX-04 — email intake:** implementation is present but acceptance is incomplete. The inbound adapter, schema, worker, admin mapping UI, sender verification, reply tokens, deduplication, scanning/quarantine, and smoke tenant are implemented. Full acceptance coverage remains incomplete; no real provider/clean-host exercise has been recorded.
- **CX-05 — SLA targets:** implementation complete. Tenant-scoped configurable targets, per-ticket calendar/target snapshots, priority-change recalculation and audit, first-response/resolution clocks, warning/breach outbox alerts, queue/report metrics, and focused tests are implemented. Proposed target values remain visibly labeled as proposed pending owner confirmation.
- **CX-07 — production handover:** implementation complete for the requested release and operations tooling: CI-gated release images, pull-only production Compose references, Caddy TLS, secret-file generator, install/upgrade guides, log rotation, 26-hour backup health threshold, disk/certificate monitoring, and scheduled encrypted offsite backups with alerting. Deployment evidence is still outstanding: clean-host install, real remote backup and alert delivery, upgrade/rollback, and a second-host restore drill.
- **CR-A — SLA review:** complete before any SLA commit. Focused PostgreSQL tests pass for clock snapshots, internal recipients, and dispatch beyond 500 candidates.
- **CR-B — configuration locking:** implementation and ADR are present. The 100-account smoke is noisy: two post-change runs measured submit p50/p95 of 413/711 ms and 439/926 ms, versus the recorded 908 ms baseline p95; this is not evidence of a repeatable improvement. Login retains exclusive revalidation, and recovery delivery now serializes by recovery row.
- **CR-C — visibility and search:** implementation is present, including FTS/trigram indexes, cursor pagination, and visibility parity coverage. Exact INC/SR number searches are prioritized and tested against records older than the first 200.
- **CR-D — headers and notification preferences:** headers and immediate/daily/off preference implementation are present. The delivery integration suite now passes against a fresh PostgreSQL database; preference-mode-specific digest tests remain to be added.
- **CR-E / CR-F:** not complete. TOTP/calendar/restic replacements, NestJS dependency injection cleanup, and support-page splitting remain outstanding.

## Verification and delivery gates

- Commit `33f698e` is pushed to `feat/structure-formatting`. Commit `1efa187` fixes the Caddy host configuration; its CI run passed app startup and gitleaks but failed during API integration tests.
- PR-A local verification: `docker compose config --quiet` passed, the web image built, and an isolated Caddy container served `/` and proxied `/api/health` with CSP/HSTS headers. A fresh-PostgreSQL API run now passes 98 tests with 1 skip, including scanning/storage/mail delivery and tenant export.
- The PR-A follow-up fixes narrow metadata privileges for the notification digest function, keeps tenant exports compatible with the generated FTS column, and makes outbox dispatch tests tolerate the global 100-event page. Those fixes are local and need a fresh GitHub run.
- Static checks passed on `33f698e`: formatting, lint (0 errors, 51 warnings), build, typecheck, production-script checks, and license check. API-wide tests did not pass; the delivery integration suite had 4 failures in the reused local fixture database.
- Full-history and staged gitleaks passed for commits `33f698e` and `1efa187`. A raw local directory scan is polluted by ignored `.env` and `.pnpm-store` files; GitHub's committed-tree gitleaks job passed.
- Do not claim production readiness until CX-07's clean-machine install, backup/restore, upgrade/rollback, offsite alert delivery, and monitoring evidence is recorded.

## Agent activity

No sub-agents were dispatched for the current handoff. Runtime token usage was not reported. PR-A follow-up changes are local and uncommitted; rerun the GitHub workflow after pushing them. No production host, DNS, SMTP credentials, or offsite backup credentials are configured here, so production deployment and clean-host recovery drills remain deployment inputs.
