# Hosted operator console

Operators are separate identities with no public registration or tenant
impersonation. The operator host requires password, TOTP, CSRF protection and
its own host-only cookie. Sessions expire after 15 minutes idle or 12 hours
absolute. Optional `OPERATOR_IP_ALLOWLIST` accepts comma-separated IPs/CIDRs;
malformed entries fail closed. Production trusts only the direct Caddy hop.

## First operator

Create a private JSON file containing `name`, `email`, `password` (at least 12
characters), and `role` (`owner` or `support`). Restrict file permissions, mount
it read-only into setup, and remove the password file after successful creation:

```sh
docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps \
  -v /etc/astrama/private-operator.json:/run/operator.json:ro \
  setup node apps/api/dist/operator-cli.js create /run/operator.json
```

Open `OPERATOR_ORIGIN` and enrol an authenticator.
Scan the locally generated QR code with your authenticator app, or expand
"Can't scan?" to enter the setup key manually as a time-based account. Both
methods use the same secret; enter the resulting six-digit code to verify.
Keep operator account recovery in the host team's private access runbook; customer administrator MFA recovery
is a separate action. Neither operator nor tenant cookies cross the host boundary.

## Permissions and actions

Both roles can inspect organisation metadata and operational counts, resend an
inactive administrator's invitation, extend a trial to an explicit date, and
request administrator MFA recovery with recorded offline identity evidence.
Invitations require an organisation with write access. Every action requires
a reason and writes an audit entry.

Owners additionally manage plans, explicitly choose seats and Stripe proration,
suspend/reactivate, extend retention and schedule deletion with exact slug and
confirmation. Assigned plan prices, interval and commercial seat terms are
immutable; create another plan to change them. Changing interval can bill
immediately even with proration `none`; inspect the intended change first.
Renewals preserve an explicit seat override. Live webhook reads and plan changes
are serialised per organisation. Automatic deletion refuses to cancel a live
active Stripe subscription until billing is reconciled.

Tenant administrators grant a **named operator** access under Organisation setup
→ Operator support access, choosing expiry within 24 hours and a reason. They
can revoke even while read-only and inspect paged support-view history. A live
grant permits read-only support and a private full organisation export. Sensitive
tickets/internal notes follow the grantor's current group memberships. Without
a grant, only metadata is available. There is no ticket mutation or browser
export download.

Export, MFA recovery and plan changes use durable jobs in the existing trusted
lifecycle worker. Refresh jobs for outcomes. Submissions are idempotent; retries
recheck permissions and organisation/admin revisions. Failed work retries up to
three times. Correct the underlying cause before submitting a new action; MFA
retries do not reset an account twice.

Exports are in the private `operator_exports` volume under `/exports`; the exact
directory is in `operator_jobs.output_directory` for trusted host retrieval.
Treat them as confidential customer data, including internal notes/attachments;
deliver through an authorised secure channel and remove under the agreed
retention policy. Monitor this volume's disk usage. It is separate from scheduled
backups. Reactivation lifts a manual operator hold, while unpaid billing remains
restricted. Review billing before reactivating a restored tenant.
