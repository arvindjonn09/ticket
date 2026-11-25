# Local testing handoff - 19 November 2026

The user asked to update the remaining work and make the application available
for testing. The existing installation was rebuilt/migrated through033 without
demo reseeding, preserving its23 tickets and existing MFA state. An encrypted
pre-update pg_dump was validated by decrypting it into pg_restore's archive
listing. The original .env/encryption key was preserved.

## Ready to test

See [local testing](../local-testing.md) for URLs, fictional account credentials,
authenticator setup and a test checklist. The normal app remains on
http://localhost:4310. A new isolated hosted sandbox provides public signup,
tenant hosts and the operator console under https://astrama.localhost:8443,
using its own database/object volumes and mailbox at http://localhost:14312.
The sandbox binds only loopback and uses test payments/captured email. No hosts
file or system certificate trust changes were made.

The complete hosted signup/email/provisioning/activation/MFA/first-ticket and
signed test-payment journey passed against these actual local URLs (23.8s).
Employee sign-in and the operator's mandatory MFA setup were also checked.
The first probe used an obsolete UI label; the actual employee workspace worked.
A container DNS mapping was added to the external test runner for Node's
request client; the application required no DNS workaround.

## Checks

- Full real-service API suite:196 passed,1 isolated bootstrap test skipped.
- New notification preference check covers daily/off/immediate delivery,
  concurrent digest dispatch, current-day deferral and critical alerts.
- Domain16/web5 tests, production preflight, lint0errors/74warnings and workspace
  typecheck pass. Production dependencies remain licence-allowlisted.
- Fresh dependency audit passes the high-severity threshold without an exception:
  upstream withdrew GHSA-fc5q-39xc-vjpf on18November. Four moderate advisories remain.
- Native Restic synthetic checks pass: round-trip, wrong password and pack
  corruption, alongside retained legacy crypto/ACL/path checks.
- Full Git history scan remains clean (21commits). Final source scan is recorded
  in task-status.md after the last edits.

## Backup migration

New backups use the pinned official BSD-2 Restic container for encrypted,
authenticated and deduplicated storage; v1 archives remain readable. Native
offsite copy/check/explicit retention replaces rclone. See
[Restic operations](../restic-backups.md). No remote production credentials,
retention policy or live offsite connection was invented.

The first safety/capture attempts found an existing Docker image-reference
problem: running containers referred to old image IDs no longer available to
start a helper after rebuild. Services/data were restored, the exact image
preflight was added before quiescence, and the intended app images were
deliberately recreated. No fallback to mutable image tags was introduced.
One isolated streaming restore then failed closed because tar exited at its end
markers before trailing record padding drained. Extraction now reads to EOF
with GNU tar --ignore-zeros, while corruption/truncation still fail. The real
2MiB padding regression and native Restic/legacy checks pass4/4. Full capture
and independent corrected restore verify all52 tables/private object/key checks;
completion evidence is tracked in task-status.md.

## Remaining external work

Production domain/region, legal text and SLA approval, customer allowances, real
Stripe/SMTP/offsite access, independent monitoring and replacement-host drills
remain owner/deployment inputs. Repository privacy remains an owner action.
No production deployment, commit or push was made by this local-test preparation.
