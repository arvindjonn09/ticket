# Hosted operations

The encrypted full-stack backup/restore procedure in [install.md](install.md)
covers all organisations, billing/operator metadata, audits, object storage and
the encryption key. Continue offsite verification and replacement-host drills.
Business exports omit credentials/sessions/inbound secrets. Private operator
exports and status history are separate volumes with their own retention policy.

## Restore one organisation

Use a verified private export, offline ingress/workers and the trusted database
owner. Restore accepts only an **absent tenant ID and slug**; it never merges or
overwrites. Replacing an existing damaged tenant requires a separately verified
full backup, specific owner deletion authorisation, and the existing offline
deletion procedure first. Preserve an unaffected backup before removal.

Prepare a private request JSON:

```json
{
  "tenantId": "UUID from manifest",
  "expectedSlug": "exact-slug-from-manifest",
  "operator": "authorised host operator",
  "reason": "customer-authorised recovery reason",
  "evidence": "private change approval reference",
  "offline": true,
  "execute": false,
  "deleteAfter": "an explicit agreed future ISO timestamp"
}
```

Run preview, inspect it, then change `execute` to true for apply:

```sh
docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps \
  -v /private/export:/run/export:ro -v /private/restore.json:/run/restore.json:ro \
  setup node apps/api/dist/tenant-restore.js /run/restore.json /run/export
```

Preview validates checksums, paths, tenant identities and database constraints
in a rolled-back transaction. Apply restores business IDs, memberships, tickets,
approvals, audits, counters, policy/SLA settings and attachment bytes. The tenant's
storage prefix must be empty. Failed writes compensate new objects before
releasing the database identity lock. If the connection drops at commit, keep
ingress offline and inspect both the tenant and prefix before retrying; never
delete objects blindly. Inspect the private operation audit for the outcome.

Restored tenants are inactive under an operator read-only hold, with the supplied
future quarantine deletion deadline. Accounts are disabled without passwords,
MFA, invitations or sessions. Old Stripe references are removed; billing and
inbound credentials must be re-established. Notification deliveries, jobs and
support grants are not replayed. A trusted owner must review billing, reactivate,
invite the administrator anew and verify MFA, routing, numbering and downloads
before reopening. Reconfigure inbound mail and verify the system intake account.
Exports are bounded to 256 MiB per records/attachment file; larger restores need
a reviewed streaming procedure.

## Per-organisation allowances

Hosted production requires an explicit positive safe integer for each value;
the example leaves them blank for the owner's deployment/customer policy:

| Variable                      | UTC window | Charged admission                                                     |
| ----------------------------- | ---------- | --------------------------------------------------------------------- |
| `TENANT_REQUESTS_PER_MINUTE`  | Minute     | Authenticated tenant API requests, excluding authentication routes    |
| `TENANT_UPLOAD_BYTES_PER_DAY` | Day        | Upload bytes, including admitted inbound attachments                  |
| `TENANT_INBOUND_PER_HOUR`     | Hour       | New authenticated inbound messages; duplicate retries are free        |
| `TENANT_OUTBOUND_PER_HOUR`    | Hour       | Tenant notification, invitation, recovery and lifecycle SMTP attempts |
| `TENANT_EXPORTS_PER_DAY`      | Day        | CSV exports and new private operator export jobs                      |

Single-company mode is unchanged. Local hosted development may omit values.
PostgreSQL admission is atomic across replicas and isolated per tenant. HTTP429
includes Retry-After. Admitted uploads count even if scanning/storage later
fails; export-job retries do not charge again. Trusted offline recovery/backups
remain available outside HTTP quotas. Maintenance removes expired counters.
These are service allowances, not billing meters or a defence against all
unauthenticated network floods.

## Monitoring and status

The production watcher tags alert lines `[tenant-slug]` for failed inbound
delivery, retried outbound notifications, and failed/overdue operator jobs. Its
database function returns counts only, without bodies, addresses or raw errors.
Worker failures log `tenantSlug`. Verify `OPERATOR_ALERT_EMAIL` delivery.

Optional Uptime Kuma runs in its own `status` profile/container and `status_data`
volume. It is MIT licensed and pinned to the digest of
[release 2.5.11](https://github.com/louislam/uptime-kuma/releases/tag/2.5.11).
Keep `STATUS_PAGE_ORIGIN` and `STATUS_SITE_HOST` blank during bootstrap:

```sh
docker compose --env-file .env.production -f compose.production.yaml --profile status up -d status
ssh -L 3001:127.0.0.1:3001 authorised-host
```

Open localhost:3001 through the tunnel, select SQLite (the container runs as
UID1000 without capabilities), create a strong administrator account,
enable MFA, configure HTTPS monitors for the public site/health, test alerts and
publish a status page without private customer URLs or secrets. Set it as the
entry page/custom domain. Follow the
[upstream proxy guide](https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy).
Only then choose the distinct status hostname/origin and DNS, set both variables,
run preflight, and recreate API/web with the status profile enabled. Caddy handles
the status host, WebSockets and on-demand certificate. Kuma's dashboard requires
its own login; never expose bootstrap before an administrator exists.

A same-host monitor cannot alert on total host/network loss: use an independent
external HTTPS observer too. If required, back up Kuma's volume following its
stopped-service procedure. Production domain, region, legal text, allowances,
real SMTP/Stripe and offsite credentials remain deployment inputs; local checks
do not establish production readiness.
