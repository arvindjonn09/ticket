# Astrama delivery status

Status updated 16 November 2026. Detailed dated delivery records are in [November history](history/2026-11.md).

## Current position

- **CX-01 — secure source control:** feature branch is pushed and PR #1 was merged after CI passed. The repository is still public; CR-01 remains an owner action.
- **CX-02 — structure and formatting:** implemented on `feat/structure-formatting` in separate tooling, formatting, API-move, and web-split commits. API and web code typecheck after relocation.
- **CX-06 — plan and agent briefs:** complete. D1–D5 are recorded as confirmed, the historical status is in `docs/history/2026-11.md`, and the integration engineer brief/model mapping are in place.
- **CX-03 — agent access and MFA:** implementation committed. The full API suite and browser matrix passed in GitHub CI on 16 November; the organisation browser fixture now enrolls its support agents in MFA.
- **CX-04 — email intake:** implementation is present; PR-B closes the reviewed reply audience/recipient, DMARC, Outlook quote, and structured failure-log findings with PostgreSQL and browser checks. Real provider and clean-host exercises remain outstanding.
- **CX-05 — SLA targets:** implementation complete. Tenant-scoped configurable targets, per-ticket calendar/target snapshots, priority-change recalculation and audit, first-response/resolution clocks, warning/breach outbox alerts, queue/report metrics, and focused tests are implemented. Proposed target values remain visibly labeled as proposed pending owner confirmation.
- **CX-07 — production handover:** implementation complete for the requested release and operations tooling: CI-gated release images, pull-only production Compose references, Caddy TLS, secret-file generator, install/upgrade guides, log rotation, 26-hour backup health threshold, disk/certificate monitoring, and scheduled encrypted offsite backups with alerting. Deployment evidence is still outstanding: clean-host install, real remote backup and alert delivery, upgrade/rollback, and a second-host restore drill.
- **CR-A — SLA review:** complete before any SLA commit. Focused PostgreSQL tests pass for clock snapshots, internal recipients, and dispatch beyond 500 candidates.
- **CR-B — configuration locking:** implementation and ADR are present. The 100-account smoke is noisy: two post-change runs measured submit p50/p95 of 413/711 ms and 439/926 ms, versus the recorded 908 ms baseline p95; this is not evidence of a repeatable improvement. Login retains exclusive revalidation, and recovery delivery now serializes by recovery row.
- **CR-C — visibility and search:** implementation is present, including FTS/trigram indexes, cursor pagination, and visibility parity coverage. Exact INC/SR number searches are prioritized and tested against records older than the first 200.
- **CR-D — headers and notification preferences:** headers and immediate/daily/off preference implementation are present. The delivery integration suite passes against fresh PostgreSQL; preference-mode-specific digest tests remain to be added.
- **CR-E / CR-F:** not complete. TOTP/calendar/restic replacements, NestJS dependency injection cleanup, and support-page splitting remain outstanding.

## Verification and delivery gates

- Commits `390eba7` and `e9389f1` are pushed to `feat/structure-formatting`. The `e9389f1` GitHub `verify` and `gitleaks` jobs both passed, including the full API suite and Chromium/Firefox/WebKit browser matrix.
- PR-A fixed the notification digest role's narrow metadata privileges, tenant export's generated FTS column, outbox dispatch paging assumptions, and MFA enrollment in the organisation browser fixture. The earlier `390eba7` browser run exposed the last fixture issue; the corrected test passes across all three browsers.
- Local verification includes 98 API tests passing with 1 skip on fresh PostgreSQL, the focused inbound-mail PostgreSQL suite (10 tests), Outlook/Gmail quote fixtures, and the three-browser organisation workflow. Static checks and license checks passed before the final PR-A test-only commit.
- Staged and GitHub gitleaks scans passed. The raw workspace scan includes ignored `.env` and package-store content and is not the committed-tree scan used by CI.
- Do not claim production readiness until CX-07's clean-machine install, backup/restore, upgrade/rollback, offsite alert delivery, and monitoring evidence is recorded.

## Agent activity

No sub-agents were dispatched for the current handoff. Runtime token usage was not reported. PR-B implementation and tests are local and uncommitted. No production host, DNS, SMTP credentials, or offsite backup credentials are configured here, so production deployment and clean-host recovery drills remain deployment inputs.
