# SA-04–SA-06 local completion handoff — 18 November 2026

The owner requested completion through SA-06 and approved group-member
administrators handling tickets. Reviewed implementation is integrated in the
main worktree, uncommitted. Original overwritten files were backed up outside
the repository; unrelated owner plans and decisions were preserved.

SA-04's real hosted onboarding journey now completes. SA-05 adds the separate
MFA operator console, tenant-granted audited read-only content access, owner
actions and trusted durable jobs. SA-06 adds offline single-tenant restore,
atomic tenant allowances, tenant-tagged alerts and the optional isolated Kuma
status page. See [delivery status](../task-status.md),
[operator runbook](../operator-console.md) and
[hosted operations](../hosted-operations.md).

Local evidence: API195 passed/1 isolated bootstrap test skipped; domain16,
web5, production/backup scripts3 pass. Fresh migrations through033 apply.
All6 hosted onboarding/operator journeys pass Chromium/Firefox/WebKit with
operator/grant accessibility checks. Workspace build/typecheck, production API
image, Caddy validation, Compose parse and 219-package licence gate pass.
Lint0 errors/74 warnings. Final source and21-commit history gitleaks scans clean.
The browser matrix preceded the final ISO-date/OpenAPI contract correction;
focused and full API regressions cover that correction.

Remaining release gate: the full development dependency audit finds
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
in picomatch through ESLint/tinyglobby, with no patched version currently
published. No suppression was added. Production-only audit is clean.
GitHub CI has not run for these uncommitted changes; do not claim it green.

Production remains unconfigured: chosen domain/region, legal text, explicit
tenant allowance values, live Stripe, real SMTP/offsite credentials, independent
external monitoring and clean-host install/restore/upgrade drills. No business
defaults were approved by fixture values. No deployment, account publication,
commit or push occurred.

OpenCode free quota was exhausted after the bounded data/auth/admin-support
drafts. Codex completed and verified the remaining work without connecting a
paid OpenCode provider. Runtime-reported external usage and corrections remain
in the agent activity log; parent token usage is unavailable.
