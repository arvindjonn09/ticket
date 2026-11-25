# Production installation

Hosted deployments also follow [operator-console.md](operator-console.md) for
separate operator accounts and [hosted-operations.md](hosted-operations.md) for
tenant restore, explicit fairness allowances, tenant-tagged alerts and the
optional private-first status page. The single-company procedure below remains
available. Do not fill production business values from local test fixtures.

This is the operator procedure for a Linux Docker host. A clean-machine
installation has not yet been rehearsed; do not treat this document as
production validation. Caddy obtains and renews the site's TLS certificate
automatically once DNS and firewall prerequisites are met.

## Host and release

Install Docker Engine with the Compose plugin and Node 24, configure host time
synchronization, point the hostname's A/AAAA records at the host, allow inbound
ports 80 and 443, restrict operator administration, and provide persistent storage with room for the database,
attachments, scanner signatures, and a full restore. Create a private release
directory and copy `compose.production.yaml`, `infra/Caddyfile`, the
`.env.production.example`, `scripts/`, and `docs/` from the release. The host
pulls the published images; it does not build them.

Generate the private env file and secrets, then set the selected release tag,
SMTP, alert address, and hosted public-site hostname/origins before enabling
hosted mode. `PUBLIC_SITE_HOST` must match the hostname in `PUBLIC_SITE_ORIGIN`;
the example `change-me.example` values are placeholders, not a domain choice.

```sh
node scripts/create-production-secrets.mjs help.example.com
```

The script refuses to overwrite an existing file and creates it with mode
`600`. Keep `.env.production` outside source control. Keep
`MFA_ENCRYPTION_KEY` stable and include it in encrypted backups. Caddy stores
certificate state in its private persistent volume; include it in host backup
planning. Certificate issuance fails until public DNS resolves correctly and
the firewall permits ports 80 and 443.

From the release directory, validate and start the stack:

```sh
chmod 600 .env.production
node scripts/check-production.mjs .env.production
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml pull
docker compose --env-file .env.production -f compose.production.yaml up -d db storage scanner setup
docker compose --env-file .env.production -f compose.production.yaml up -d --wait api worker lifecycle web
```

Use the one-off operator provisioning command in
[operations.md](operations.md#provision-a-new-organisation) to create the first
administrator. It requires a private organisation configuration and the setup
image. Do not enable real users until HTTPS, SMTP, MFA enrollment, backup,
restore, external uptime monitoring, and owner alert delivery have been
verified.

## Unattended monitoring and backups

Use the pinned native Restic container and custody procedure in
[Restic backup operations](restic-backups.md). Create `/etc/astrama/backup.env`
with owner-only permissions and explicit deployment values:

```sh
APP_DOMAIN=help.example.com
RESTIC_REMOTE_REPOSITORY=s3:https://storage.example.com/bucket/astrama/backups
BACKUP_RETENTION_DAYS=<explicit-approved-days>
BACKUP_KEY_FILE=/etc/astrama/private-backup-key
AWS_ACCESS_KEY_ID=<private-offsite-key>
AWS_SECRET_ACCESS_KEY=<private-offsite-secret>
```

The remote must be dedicated to this installation, limited to that prefix, and
initialised separately with the same backup password. No default customer
retention is selected here. Keep credentials and the backup password in separate
private custody; never put them in source control. Retain the encrypted legacy
archives and their original key; the restore command still reads them.

Create `/etc/astrama` owned by the service account with mode 700 and initialise
the private local key/repository with the first verified backup:

```sh
sudo install -d -o astrama -g astrama -m 700 /etc/astrama
sudo -u astrama env BACKUP_KEY_FILE=/etc/astrama/private-backup-key node scripts/backup-stack.mjs backup --verify --init-key --compose compose.production.yaml --project astrama-production --env-file .env.production
```

Keep another copy of the backup key in an independent secret vault. Protect the
key/scheduler environment with mode 600 and `/opt/astrama/.local-backups` with
mode 700. Preserve the entire Restic repository: pointer directories alone do
not contain backup data.

Install the five unit files from `deploy/systemd/` under `/etc/systemd/system/`,
then enable the timers:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now astrama-offsite-backup.timer astrama-host-watch.timer
```

Each scheduled backup captures the database, objects and application key,
verifies a full isolated restore, copies native encrypted snapshots, checks the
remote data, then applies the explicitly configured retention. Failures attempt
an operator email alert. The host watcher checks disk and certificate expiry.
Use an independent external HTTPS monitor for whole-host/network outages.
Real offsite IAM, connectivity and alert delivery must be tested before launch.

## Replacement-host restore drill

Use a second clean Linux VM with Docker Compose, Node 24, the exact released
images, private deployment configuration, access to the remote Restic prefix
and the separately retrieved backup password. Follow
[replacement-host recovery](restic-backups.md#recover-on-a-replacement-host) to
copy the required backup group into an empty private repository. Then run:

```sh
BACKUP_KEY_FILE=/etc/astrama/private-backup-key node scripts/backup-stack.mjs restore --verify --backup .local-backups/backup-<timestamp>-<id> --compose compose.production.yaml --project astrama-production --env-file .env.production
```

Record the release, snapshot time, restore result and elapsed time. Verification
uses isolated temporary database/object volumes and never overwrites a live
stack. A local drill does not replace this independent-host exercise.
