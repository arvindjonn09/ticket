# Astrama delivery status

Status updated 16 November 2026. Detailed dated delivery records are in [November history](history/2026-11.md).

## Current position

- **CX-01 — secure source control:** feature branch is pushed and PR #1 was merged after CI passed. The repository is still public; CR-01 remains an owner action.
- **CX-02 — structure and formatting:** implemented on `feat/structure-formatting` in separate tooling, formatting, API-move, and web-split commits. API and web code typecheck after relocation.
- **CX-06 — plan and agent briefs:** complete. D1–D5 are recorded as confirmed, the historical status is in `docs/history/2026-11.md`, and the integration engineer brief/model mapping are in place.
- **CX-03 — agent access and MFA:** implementation committed. The full API suite and browser matrix passed in GitHub CI on 16 November; the organisation browser fixture now enrolls its support agents in MFA.
- **CX-04 — email intake:** implementation is present; PR-B through PR-D close the reviewed reply audience/recipient, DMARC, Outlook quote, failure logging, raw-body signing, route limits, uniform webhook errors, rate-limit trace, unverified requester, triage SLA, and resolved-ticket parity findings. Focused PostgreSQL coverage passed locally. Real provider and clean-host exercises remain outstanding.
- **CX-05 — SLA targets:** implementation complete. Tenant-scoped configurable targets, per-ticket calendar/target snapshots, priority-change recalculation and audit, first-response/resolution clocks, warning/breach outbox alerts, queue/report metrics, and focused tests are implemented. Proposed target values remain visibly labeled as proposed pending owner confirmation.
- **CX-07 — production handover:** implementation complete for the requested release and operations tooling: CI-gated release images, pull-only production Compose references, Caddy TLS, secret-file generator, install/upgrade guides, log rotation, 26-hour backup health threshold, disk/certificate monitoring, and scheduled encrypted offsite backups with alerting. Deployment evidence is still outstanding: clean-host install, real remote backup and alert delivery, upgrade/rollback, and a second-host restore drill.
- **CR-A — SLA review:** complete before any SLA commit. Focused PostgreSQL tests pass for clock snapshots, internal recipients, and dispatch beyond 500 candidates.
- **CR-B — configuration locking:** implementation and ADR are present. The 100-account smoke is noisy: two post-change runs measured submit p50/p95 of 413/711 ms and 439/926 ms, versus the recorded 908 ms baseline p95; this is not evidence of a repeatable improvement. Login retains exclusive revalidation, and recovery delivery now serializes by recovery row.
- **CR-C — visibility and search:** implementation is present, including FTS/trigram indexes, cursor pagination, and visibility parity coverage. Exact INC/SR number searches are prioritized and tested against records older than the first 200.
- **CR-D — headers and notification preferences:** headers and immediate/daily/off preference implementation are present. The delivery integration suite passes against fresh PostgreSQL; preference-mode-specific digest tests remain to be added.
- **PR-C / PR-D:** implementation and focused PostgreSQL tests are complete. GitHub `verify` and `gitleaks` passed on `8982471`; PR-D adds the inactive `system` role via migration `202611160022_inbound_system_requester`.
- **CR-E:** TOTP is now backed by otplib and business calendar calculations by Luxon, with the existing RFC/DST/holiday regressions passing. The Restic replacement for the custom encrypted backup/transport is still open; current recovery code remains the proven AES-256-GCM snapshot workflow until that migration can preserve its isolated restore drill.
- **CR-F:** notification worker collaborators now resolve through Nest providers, and support routes, shared UI, ticket sidebar, and message composer are split into focused files. API/web typechecks and provider-construction test pass locally; GitHub `verify` and `gitleaks` passed on `8982471`.

## Verification and delivery gates

- Commits `390eba7`, `e9389f1`, `f55cf94`, and `8982471` are pushed to `feat/structure-formatting`. GitHub `verify` and `gitleaks` passed on both `e9389f1` and `8982471`; the latter includes the full API suite and Chromium/Firefox/WebKit browser matrix.
- PR-A fixed the notification digest role's narrow metadata privileges, tenant export's generated FTS column, outbox dispatch paging assumptions, and MFA enrollment in the organisation browser fixture. The earlier `390eba7` browser run exposed the last fixture issue; the corrected test passes across all three browsers.
- Local verification on this worktree: API suite 115 passed / 4 skipped on a fresh isolated PostgreSQL database; delivery integration 4 passed / 1 skipped; formatting, lint (0 errors), typecheck, build, and the 215-package license gate passed. Browser matrix still needs GitHub CI on the new commits.
- Staged and GitHub gitleaks scans passed. The raw workspace scan includes ignored `.env` and package-store content and is not the committed-tree scan used by CI.
- Do not claim production readiness until CX-07's clean-machine install, backup/restore, upgrade/rollback, offsite alert delivery, and monitoring evidence is recorded.

## Agent activity

No sub-agents were dispatched for the current handoff. Runtime token usage was not reported. PR-B is committed locally in `f55cf94`; PR-C/PR-D and the documented CR-E/CR-F changes are in the worktree. No production host, DNS, SMTP credentials, or offsite backup credentials are configured here, so production deployment and clean-host recovery drills remain deployment inputs.
