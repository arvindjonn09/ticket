# Encrypted database, object and key recovery

`scripts/backup-stack.mjs` backs up PostgreSQL, the entire private RustFS `/data` volume, and the application MFA encryption key plus storage credentials. It immediately restores them into a new isolated PostgreSQL/RustFS network and verifies the result. It never restores into the live database or object volume. Node 24 and the local Docker CLI are the only host dependencies; it uses the stack's existing immutable image IDs and installed API dependencies.

Before capture, stop other tests, imports and direct database/object writers. The script validates the local Unix socket/Windows named-pipe Docker context, Compose service/workspace labels and named RustFS volume. It stops the API, web and worker that were running, creates a temporary verification fixture, stops RustFS, and streams `pg_dump -Fc` and a complete volume tar directly into authenticated AES-256-GCM encryption. It restores RustFS and the original running application services in `finally`, removes its source fixture, and verifies the retained encrypted snapshot independently. Capture briefly makes the application unavailable. An API/worker already stopped stays stopped.

Set a separate `BACKUP_ENCRYPTION_KEY` to a private 64-character hexadecimal value, or point `BACKUP_KEY_FILE` to a private file containing it. This key must differ from `MFA_ENCRYPTION_KEY`. For a first local run only:

```sh
node scripts/backup-stack.mjs backup --verify --init-key
```

`--init-key` creates `.local-backups/private-backup-key` once with exclusive file creation and restricted current-user permissions; it never prints the key or changes `.env`. On Windows, the generated backup directory DACL is replaced with only the current owner, removing inherited and explicit grants to other principals. Existing key files must have a protected current-owner-only ACL and a parent that prevents deletion by others; on Unix they must be owned by the current user, mode 0600 or stricter, in a directory others cannot write. Store a second copy of the backup key in a separate off-host secret vault before relying on these backups. Keep the decryption key separate from the copied backup artifacts. Losing both copies makes the backup unrecoverable. The `.local-backups/` tree is ignored by Git; the script refuses write/cleanup paths outside it, including Windows junctions or symbolic links.

Subsequent captures:

```sh
node scripts/backup-stack.mjs backup --verify
```

Each generated backup directory retains only encrypted files:

| File | Contents |
| --- | --- |
| `database.dump.enc` | PostgreSQL custom-format dump, including schema, policies, grants and rows |
| `storage.tar.enc` | Complete RustFS data volume, including object and bucket metadata |
| `secrets.json.enc` | Application MFA key and private storage credentials |
| `manifest.json.enc` | Authenticated SHA-256 hashes of the three artifacts, source image IDs, table counts, object byte hashes and fixture identity |
| `verification.json.enc` | Completion time and non-content verification totals, written only after successful full restore |

Each artifact has a distinct authenticated identity, random 96-bit nonce and 128-bit GCM tag. No plaintext dump, archive, secret file or manifest is staged on the host. Failed captures may retain an incomplete encrypted directory; a missing authenticated manifest or verification file identifies an incomplete operation. There is no automatic retention deletion or external upload. Copy completed encrypted artifacts and archive the exact released API/PostgreSQL/RustFS images separately under your agreed offsite and retention policy. Verification uses captured immutable image IDs; a replacement host needs those images loaded first. Offsite credentials, image distribution, storage and customer retention periods are deployment inputs.

To verify a retained backup again, select its directory:

```sh
node scripts/backup-stack.mjs restore --verify --backup .local-backups/backup-<timestamp>-<id>
```

The command authenticates the manifest and artifact hashes, decrypts streams into fresh uniquely named Docker volumes, creates the expected `astrama_app` and `astrama_auth_reader` roles before `pg_restore`, and starts isolated PostgreSQL and RustFS containers on an internal network without host ports. The restored API image checks every public-table row count, every S3 object's size and SHA-256 byte hash, unauthenticated denial for a private fixture object, and decryption of every retained MFA/invitation/recovery/recovery-request secret using the recovered application key. It also verifies that the restored runtime role has no RLS bypass and cannot read tickets without tenant context.

A temporary `backup-verify-<UUID>` tenant, four known encrypted secret types (including the infrastructure recovery-request queue), and one random 4 KiB object under `_backup-verification/<UUID>.bin` ensure these recovery paths are exercised even when the installation has no customer attachments or pending invitations. The fixture is present only in the captured backup and is deleted from the live source before normal services resume. It is not an enabled login or delivery destination. The isolated verification network cannot send SMTP or access external services. Generated containers, volumes and network are removed only after checking their UUID name and ownership label, including on failure. Restoring for actual service recovery requires a separately provisioned maintenance destination, removal of this documented fixture, recovered keys and a controlled traffic cutover; this verification command deliberately exposes no live overwrite option.

The `backup` operation writes a successful `operation_heartbeats` entry only after the isolated restore, all data/secret checks and generated-resource cleanup succeed. Nonzero exits indicate capture, verification, cleanup or heartbeat failure. Monitor both the exit status and a stale backup heartbeat; the admin operations page considers a success older than 48 hours stale. A retained-backup recheck does not update the live backup heartbeat. An exclusive `.local-backups/active-backup.lock` rejects overlapping captures. SIGINT/SIGTERM trigger cleanup and source-service restoration; forced process termination, host failure or Docker outage still require checking source services and UUID-labelled leftovers. After a hard crash, remove that single stale lock file only after confirming the original process has ended and source services are restored.

Run the small authentication/path checks without stopping services:

```sh
node --test scripts/backup-stack.test.mjs
```

Windows scheduling is explicit and is not installed by ordinary application setup:

```powershell
.\scripts\schedule-backup.ps1                 # explains the opt-in, changes nothing
.\scripts\schedule-backup.ps1 -Install -At 02:00
```

The task uses the installing user's local time, runs while that Windows user is logged in, and needs Docker Desktop running. It ignores overlapping task instances. For unattended Linux hosts, use the deployment scheduler to run the same Node command and route failures to the operational alert wrapper. Never embed the backup key in a task command line; use its private file or scheduler-provided environment.

Alternate Compose files inside this workspace are selected with `--compose <file> --project <name> --env-file <private-env-file>`, for example `--compose compose.production.yaml --project astrama-production --env-file .env.production`. Both development and minimal production API image layouts are supported. The same service names, explicit Astrama owner, PostgreSQL 16, local Docker daemon and private named RustFS `/data` volume are required. Select a local context with `--context <name>` rather than Docker environment overrides. Database/image upgrades require a fresh restore rehearsal before adopting a new backup format or release.

## Local verification — 11 November 2026

The full capture and isolated restore passed at 01:42 UTC, and the retained-backup CLI independently passed at 01:43 UTC after source fixtures had been removed. Both verified 31 public tables, one private object's byte hash, and recovered-key decryption of two MFA secrets plus one invitation, one recovery link and one queued recovery request. The extra secret/object records are the documented fixture; no source fixture tenant remained. Live API, database, scanner and worker returned healthy, and all generated restore containers, volumes and networks were removed. The retained directory is `.local-backups/backup-2026-11-11T01-41-50-875Z-5de1b5b23f3e48c88a82e7eb9672bf97`, containing only the five `.enc` artifacts above.

The independent repeat exposed and fixed a PostgreSQL initialization race: readiness now uses TCP rather than the temporary initialization server's Unix socket. Authentication/tamper, wrong-key, path/junction and explicit Windows Everyone-ACL regression checks also passed. This is a complete local data/object/key restoration rehearsal; external offsite storage and recovery on replacement hardware still require deployment-specific custody and infrastructure.
