# Astrama delivery status

Status updated 14 November 2026. Detailed dated delivery records are in [November history](history/2026-11.md).

## Current position

- **CX-01 — secure source control:** complete. Feature branch is pushed, gitleaks is clean on the working tree and full history, and PR #1 was merged after GitHub CI passed.
- **CX-02 — structure and formatting:** implemented on `feat/structure-formatting` in separate tooling, formatting, API-move, and web-split commits. API and web code typecheck after relocation. Full final CI and gitleaks remain pending before push.
- **CX-06 — plan and agent briefs:** complete. D1–D5 are recorded as confirmed, the historical status is in `docs/history/2026-11.md`, and the integration engineer brief/model mapping are in place.
- **CX-03 — agent access and MFA:** implementation committed. Focused domain, request, incident, launch-safety and organisation integration checks passed on isolated PostgreSQL; full API suite and final CI remain pending.
- **CX-04 — email intake:** implementation is present but acceptance is incomplete. The inbound adapter, schema, worker, admin mapping UI, sender verification, reply tokens, deduplication, scanning/quarantine, and smoke tenant are implemented. Full acceptance coverage remains incomplete; no real provider/clean-host exercise has been recorded.
- **CX-05 — SLA targets:** implementation complete. Tenant-scoped configurable targets, per-ticket calendar/target snapshots, priority-change recalculation and audit, first-response/resolution clocks, warning/breach outbox alerts, queue/report metrics, and focused tests are implemented. Proposed target values remain visibly labeled as proposed pending owner confirmation.
- **CX-07 — production handover:** implementation complete for the requested release and operations tooling: CI-gated release images, pull-only production Compose references, Caddy TLS, secret-file generator, install/upgrade guides, log rotation, 26-hour backup health threshold, disk/certificate monitoring, and scheduled encrypted offsite backups with alerting. Deployment evidence is still outstanding: clean-host install, real remote backup and alert delivery, upgrade/rollback, and a second-host restore drill.
- **CR-A — SLA review:** complete before any SLA commit. Focused PostgreSQL tests pass for clock snapshots, internal recipients, and dispatch beyond 500 candidates.
- **CR-B — configuration locking:** implementation and ADR are present. The 100-account smoke is noisy: two post-change runs measured submit p50/p95 of 413/711 ms and 439/926 ms, versus the recorded 908 ms baseline p95; this is not evidence of a repeatable improvement. Login retains exclusive revalidation, and recovery delivery now serializes by recovery row.
- **CR-C — visibility and search:** implementation is present, including FTS/trigram indexes, cursor pagination, and visibility parity coverage. Exact INC/SR number searches are prioritized and tested against records older than the first 200.
- **CR-D — headers and notification preferences:** headers and immediate/daily/off preference implementation are present. The full delivery integration suite is currently failing in this local reused fixture environment; resolve and rerun before calling the packet complete.
- **CR-E / CR-F:** not complete. TOTP/calendar/restic replacements, NestJS dependency injection cleanup, and support-page splitting remain outstanding.

## Verification and delivery gates

- CR-A focused SLA PostgreSQL tests passed (3/3); CR-C incident/search and load suites passed (16/16), CR-B request and launch-safety suites passed (19/19) after fixes. A subsequent API-wide run had 7 failures across launch-safety, recovery, and request tests; those affected cases were fixed, and their focused rerun passed (19/19). CR-D delivery integration rerun currently has 4 failures (attachment setup, recipient expectations, SLA report metrics, and pending-outbox fixture contamination). Full CI has not passed.
- Gitleaks full-history scan passed. Working-tree scan reported 34 findings: one in ignored local `.env` and the rest in ignored `.pnpm-store` package cache files. The local `.env` finding has not been classified or rotated; do not push until it is resolved and the working-tree scan is clean.
- Do not claim production readiness until CX-07's clean-machine install, backup/restore, upgrade/rollback, offsite alert delivery, and monitoring evidence is recorded.

## Agent activity

No sub-agents were dispatched for the current handoff. Runtime token usage was not reported. No commit or push has been made. Do not push until full CI and both gitleaks scans pass; the ignored local `.env` still has an unclassified finding.
