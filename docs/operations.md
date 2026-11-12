# Local provisioning and recovery

These tools operate the local development installation. They are not a production deployment or disaster recovery certification. Runtime API and worker credentials remain separate from the migration/provisioning owner credentials.

## Provision a new organisation

On a fresh PostgreSQL cluster, export the explicit owner connection in `MIGRATION_DATABASE_URL` and a private runtime password in `APP_DB_PASSWORD`, then run `pnpm db:bootstrap` **before** `pnpm db:migrate`. Bootstrap creates the restricted `astrama_app` login and its queue schema, and refuses an existing privileged/public-table-owning runtime role or a queue schema owned by someone else. Re-running bootstrap sets the configured runtime password; keep it aligned with the API/worker connection string. Applied migrations grant the runtime its tenant-scoped privileges independently of demo seeding. Production-style provisioning must not run the fictional demo seed.

Generate Prisma and build the API before provisioning. Run provisioning on a trusted operator machine with the owner connection in `MIGRATION_DATABASE_URL`, the exact public origin in `APP_ORIGIN`, and the same private `MFA_ENCRYPTION_KEY` used by the API and worker. The command never falls back to `DATABASE_URL`. It creates a new organisation only; a duplicate slug fails without changing existing users, passwords, MFA, invitations or configuration. Do not use the fictional demo seed as an account recovery tool: the development seed deliberately refreshes demo passwords.

Save an explicit JSON file outside version control, for example `new-organisation.json`:

```json
{
  "slug": "example-company",
  "name": "Example Company",
  "brandName": "Example Service Desk",
  "admin": {
    "name": "Organisation Administrator",
    "email": "administrator@example.invalid"
  }
}
```

The slug must have 3–80 lowercase letters, digits or hyphens, starting and ending with a letter/digit. Names and email are validated; unknown fields are rejected. UTF-8 JSON with or without a BOM is accepted.

```powershell
node apps/api/dist/provision.js C:\private\new-organisation.json
```

Default output contains only organisation slug, administrator email and `emailQueued:true`. A trusted operator can explicitly request the single-use link for secure manual handoff:

```powershell
node apps/api/dist/provision.js C:\private\new-organisation.json --show-invitation
```

Do not capture that optional output in shared terminal transcripts, tickets or logs. No plaintext password is generated for disclosure. Provisioning hashes a random, undisclosed password and creates an inactive administrator, a 48-hour invitation and encrypted email outbox record in one database transaction. It also creates an empty triage queue and an audit event. The worker delivers queued email; the local SMTP capture UI is at http://localhost:4312. Delivery status is distinct from queued status.

The administrator follows the invitation, chooses a password, signs in, and enrolls/verifies MFA before accessing organisation administration. They then invite the actual support agents, add active agents to triage, and configure their own groups, routing, request catalog and approvals. The initial triage queue intentionally has no fictional staff member.

There is no public signup or existing-tenant overwrite switch. Users can request a single-use password-reset email; resetting the password preserves enrolled MFA and revokes sessions. Authenticated password changes require the current password. Lost administrator MFA uses the separate owner-only recovery command with verified identity evidence and an audit trail. See [recovery and key rotation](recovery.md); never infer identity from an email address alone. Another authorised organisation administrator can re-invite inactive accounts through the UI.

## Make and verify a local database backup

For current full recovery use [encrypted database, object and key backups](backup-recovery.md). The older database-only script below remains a diagnostic utility and does not replace the full backup.

From the repository workspace, with the local Compose PostgreSQL service running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local.ps1
```

The script accepts no destination, container or restore-target arguments. It verifies a local `default`/`desktop-linux` Docker socket, rejects endpoint environment overrides, and checks the running `astrama-local` PostgreSQL 16 `db` service. It creates a custom-format `pg_dump` inside that container, copies the binary directly into this workspace's ignored `.local-backups` directory, restores into a fresh `astrama_restore_<random hex>` database, checks table counts and migration presence, then drops only that generated disposable database. The original `astrama` database is never a restore target. A single generated container dump file is removed; the host backup is retained. Paths and the disposable database name are validated before cleanup. The script refuses a linked/junction backup directory.

Output includes restored counts, retained backup path and SHA-256 checksum; it prints no ticket, user, password, token or attachment content. `pg_dump` provides a consistent database snapshot. Counts describe the restored snapshot, not an equality assertion against a live database that may have changed during backup. A successful check demonstrates that this local dump can be restored with the roles already installed on this PostgreSQL instance; it does not prove application-level recovery or cross-host completeness.

Treat every backup as confidential: it includes all tenants, private ticket content, password hashes, sessions, encrypted MFA secrets and pending invitation payloads. Keep `.local-backups` out of source control and shared sync folders. Copy required backups to access-controlled encrypted storage with an agreed retention policy; this script does not provide off-machine retention or encryption at rest. Never upload a dump to a ticket for troubleshooting.

## Recovery boundaries and rehearsal

1. Record the deployed code/migration version and back up the database before upgrades. Retain the matching migration files and application build.
2. Back up the private `MFA_ENCRYPTION_KEY` separately in secure key storage, with a tested authorised retrieval process. Losing it prevents decryption of enrolled MFA and pending invitations. Keep database credentials, SMTP credentials and object-storage credentials separately protected. Do not put secrets in this runbook or Git.
3. Back up the private object-storage bucket/volume independently. Database attachment rows contain metadata and object keys; PostgreSQL dumps do not include uploaded file bytes. Record bucket configuration and the scanning service configuration as part of recovery material.
4. Provision PostgreSQL roles and grants before restoring to a separate instance. `pg_dump` does not export global roles/passwords. The local rehearsal preserves function ownership and grants because the required roles already exist; do not add blanket superuser privileges to the runtime role to work around restore errors.
5. Restore into an isolated environment first, with outbound SMTP disabled or directed to an isolated capture service. A restored outbox can replay pending notifications and invitations; an SMTP acknowledgement lost before the database commit may cause duplicate messages. Invitation tokens remain single-use.
6. Verify migration state, tenant isolation with the non-owner runtime role, sign-in/MFA, one permitted ticket workflow, object downloads and scanning before considering a cutover. Database row counts alone do not verify these behaviours. Revoke restored sessions as part of an authorised incident-recovery plan when required.
7. Production backup frequency, retention, recovery-time/recovery-point targets, restore authorisation, real mail configuration and a live-database cutover procedure require a deployment-specific decision. This local script provides no live restore command or automatic account/MFA recovery.
