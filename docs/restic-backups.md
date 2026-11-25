# Restic backup operations

Restic [0.19.1](https://github.com/restic/restic/releases/tag/v0.19.1), BSD-2-Clause,
is pinned to the official multi-platform image digest
`restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`.
The container receives no Docker socket, drops all capabilities, runs with the
host UID/GID (UID1000 on Windows Docker Desktop), uses a read-only filesystem,
and receives only the private repository bind mount and streamed artifact.
Local operations have no network. Only explicit remote copy/check/retention
commands receive egress and the configured S3 credentials.

## Capture and custody

See [backup and recovery](backup-recovery.md). The existing `BACKUP_KEY_FILE`
contains a private random64-character hex value; Restic uses that value as the
repository password. `--init-key` preserves an existing key, or creates a new
private one exclusively, then initialises a missing local repository.
`--init-repository` initialises with an already configured key. Never replace the
key to fix an authentication failure. Keep it in a separate off-host vault.

Artifacts are independent native snapshots (`database.dump`, `storage.tar`,
`secrets.json`, `manifest.json`, `verification.json`) tagged with a common backup
UUID and an installation identifier. No custom cipher, nonce, authentication
tag or transport is applied to new captures. Restic encrypts/authenticates,
compresses and deduplicates the content. The manifest and full isolated restore
check provide application consistency. Failed/incomplete groups lack a valid
verification snapshot and must never be advertised as recoverable captures.

The local repository is `.local-backups/restic-repository`. Generated sibling
directories contain `restic.json` (format/UUID) and, after success, `verified.json`
(UUID/time), both without credentials/content. Preserve pointers with the
repository; these tiny files alone are not backups. Restic resolves artifacts by
authenticated UUID/name tags, so copying between repositories may change native
snapshot IDs without breaking an application backup group.

## Offsite repository

Choose a dedicated S3-compatible bucket/prefix ending in `/astrama/backups`.
Do not reuse another installation's Restic repository. Set these in the private
scheduler environment (not Git):

```sh
RESTIC_REMOTE_REPOSITORY=s3:https://storage.example.com/bucket/astrama/backups
BACKUP_RETENTION_DAYS=<explicit-approved-days-between-7-and-3650>
BACKUP_KEY_FILE=/etc/astrama/private-backup-key
AWS_ACCESS_KEY_ID=<private-offsite-key>
AWS_SECRET_ACCESS_KEY=<private-offsite-secret>
```

`AWS_SESSION_TOKEN` and `AWS_DEFAULT_REGION` are forwarded when configured.
The offsite credentials must be limited to the selected installation prefix.
The old `BACKUP_OFFSITE_REMOTE`/rclone setting no longer selects new transports.
Retain old v1 archives and their custody; no migration deletes them.

Initialise the remote once with the **same backup password** through a private
file mount. Set `RESTIC_REPOSITORY` to the chosen remote in that shell, then:

```sh
docker run --rm -e RESTIC_REPOSITORY -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN -e AWS_DEFAULT_REGION \
  -e RESTIC_PASSWORD_FILE=/run/restic-password \
  --mount type=bind,source=/etc/astrama/private-backup-key,target=/run/restic-password,readonly \
  restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 init
```

Run `node scripts/offsite-backup.mjs` through the existing production scheduler.
It captures and fully restores locally first, copies that authenticated group
with native Restic, checks remote encrypted data, then applies the explicit
retention using native `forget --keep-within ... --prune`. Retention selects only
this local repository's installation tag and groups snapshots by host/artifact
path, retaining the latest artifact even when older than the period. No local
repository packs or legacy directories are deleted by the wrapper. A failed
capture, copy, integrity check or prune fails the scheduled job and attempts the
existing operator alert. Remote connectivity, IAM and real alert delivery must
be validated with deployment credentials; local checks cannot certify them.

## Recover on a replacement host

Retrieve the password separately from its vault. Restore the matching release
and exact captured API/PostgreSQL/RustFS images (native snapshots record immutable
image IDs; a remote repository alone does not distribute those images).
Keep the destination offline and use an empty, private local repository.
Initialise it with the recovered password. Use the pinned Restic container to
`copy --from-repo` the remote group into the local repository, selecting the
backup UUID tag. Mount the local repository at `/repository`; set
`RESTIC_REPOSITORY=/repository`, `RESTIC_FROM_REPOSITORY` to the remote, and both
password-file variables to the recovered read-only key file. Preserve TLS
validation and forward only the configured S3 credentials.

Recreate the private original `backup-<timestamp>-<UUID>` pointer directory with
`restic.json` containing `{"format":"astrama-restic-v2","backupId":"<32hexUUID>"}`,
or restore its retained pointer alongside the repository. Then run:

```sh
node scripts/backup-stack.mjs restore --verify --backup .local-backups/backup-<timestamp>-<UUID>
```

The verification never overwrites live data. Actual production cutover remains a
separate controlled recovery procedure after the isolated drill and fixture
removal; record the release, snapshot time, outcome and elapsed recovery time.
For a v1 backup directory, the same command automatically selects authenticated
legacy reads. Keep its original key and artifacts intact until retention and
owner-approved replacement-host evidence allow retirement.
