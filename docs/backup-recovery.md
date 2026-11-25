# Encrypted database, object and key recovery

New captures use native Restic0.19.1 in a pinned official backup container.
The Node script orchestrates source quiescence, streams, custody and the same
isolated PostgreSQL/RustFS restore drill; it no longer implements new backup
encryption. Retained v1 AES-GCM snapshots remain readable through the same
restore command. See [Restic operations](restic-backups.md) for repository,
offsite and replacement-host instructions.

Before capture, stop other tests, imports and direct writers. Only the selected
local Compose project is touched. The script validates service/workspace labels,
PostgreSQL16, the private named RustFS volume and a local Docker endpoint. It
stops previously running web/API/notification/lifecycle services, creates a
private verification fixture, stops storage, and streams a custom-format database
dump, complete object volume tar, application key and metadata to encrypted,
deduplicated Restic snapshots. Source fixture cleanup and restoration of the
originally running services occur in finally. Capture briefly takes the app
offline. A service that was already stopped stays stopped.

Use a separate BACKUP_KEY_FILE or BACKUP_ENCRYPTION_KEY (64hex characters),
different from the application MFA key. Preserve an independent off-host copy
in a secret vault. Existing key-file owner/ACL/mode and no-link checks remain.
No key is printed or written to .env. First capture, including safe repository
initialisation (an existing key is never overwritten):

```sh
node scripts/backup-stack.mjs backup --verify --init-key
```

If migrating an existing private key, --init-repository initialises Restic
without requesting a new key. Subsequent captures omit both init flags.
.local-backups/restic-repository contains encrypted Restic packs; generated
backup-<timestamp>-<UUID> directories contain only non-secret UUID/completion
pointers. Keep the repository and pointers together. Copying a pointer alone
is not a backup. No plaintext dump, tar, customer data or key is staged.

```sh
node scripts/backup-stack.mjs backup --verify
node scripts/backup-stack.mjs restore --verify --backup .local-backups/backup-<timestamp>-<UUID>
node --test scripts/backup-stack.test.mjs
RUN_RESTIC_TESTS=true node --test scripts/backup-stack.test.mjs
```

The optional container check uses a disposable synthetic repository only and
verifies round-trip bytes, wrong-password rejection and pack corruption.
It never stops or reads the application's containers.

Every capture is fully restored into generated UUID-labelled private Docker
volumes/network without host ports, SMTP, workers or an HTTP app. Verification
checks every public-table row count, all private object hashes/sizes, rejection
of anonymous private-object reads, all retained encrypted application secrets
and the restricted runtime role's missing-context RLS denial. Secret checks
include users, invitations, recovery links/requests, operators, public-mail
URLs and inbound-mail configuration where those tables exist. Old v1 manifests
without the newer tables remain compatible.

Only successful complete restore and generated-resource cleanup can write the
backup heartbeat and completion marker. Existing active-backup.lock ownership,
signal handling and UUID/label cleanup guards remain. Forced process/host/daemon
failure still needs operator inspection of source services, labelled containers
and Restic locks. Never force-unlock while a real operation is running. No
automatic local or offsite retention period is chosen; the offsite wrapper
requires the explicit configured policy.

Windows scheduling remains opt-in with scripts/schedule-backup.ps1 -Install.
The Windows user must be logged in with Docker Desktop running. Production uses
the existing systemd wrapper and explicit private backup environment. Scheduled
offsite transport now uses native Restic copy/check/forget rather than rclone.
Legacy backup directories and keys are not converted, deleted or rotated.

## Local Restic verification - 19 November 2026

Full capture and isolated restore passed at06:19:16UTC, verifying52public tables,
private object bytes, application-secret decryption and restricted runtime RLS.
The source installation returned healthy with2organisations/23tickets unchanged.
Independent corrected restore passed at06:21:30UTC. All4native checks pass,
including draining2MiB tar padding and rejecting corrupt/truncated content.
See task-status.md for the captured backup group.
This does not establish real offsite or replacement-host readiness.

## Local verification — 11 November 2026

The full capture and isolated restore passed at 01:42 UTC, and the retained-backup CLI independently passed at 01:43 UTC after source fixtures had been removed. Both verified 31 public tables, one private object's byte hash, and recovered-key decryption of two MFA secrets plus one invitation, one recovery link and one queued recovery request. The extra secret/object records are the documented fixture; no source fixture tenant remained. Live API, database, scanner and worker returned healthy, and all generated restore containers, volumes and networks were removed. The retained directory is `.local-backups/backup-2026-11-11T01-41-50-875Z-5de1b5b23f3e48c88a82e7eb9672bf97`, containing only the five `.enc` artifacts above.

The independent repeat exposed and fixed a PostgreSQL initialization race: readiness now uses TCP rather than the temporary initialization server's Unix socket. Authentication/tamper, wrong-key, path/junction and explicit Windows Everyone-ACL regression checks also passed. This is a complete local data/object/key restoration rehearsal; external offsite storage and recovery on replacement hardware still require deployment-specific custody and infrastructure.
