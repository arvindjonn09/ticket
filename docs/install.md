# Production installation

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
SMTP, and alert address:

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
docker compose --env-file .env.production -f compose.production.yaml up -d --wait api worker web
```

Use the one-off operator provisioning command in
[operations.md](operations.md#provision-a-new-organisation) to create the first
administrator. It requires a private organisation configuration and the setup
image. Do not enable real users until HTTPS, SMTP, MFA enrollment, backup,
restore, external uptime monitoring, and owner alert delivery have been
verified.

## Unattended monitoring and backups

Configure an rclone remote with write/delete access limited to this installation's
backup prefix. Keep its config private. Create `/etc/astrama/backup.env` with
owner-only permissions and the deployment values below; the rclone remote must
end in `/astrama/backups` so retention cannot target a bucket or remote root.

```sh
APP_DOMAIN=help.example.com
BACKUP_OFFSITE_REMOTE=offsite:company/astrama/backups
BACKUP_RETENTION_DAYS=30
BACKUP_KEY_FILE=/etc/astrama/private-backup-key
RCLONE_CONFIG=/etc/astrama/rclone.conf
```

Create `/etc/astrama` owned by the `astrama` service account with mode `700`,
then create the key file once by running the first verified production backup
with `--init-key`:

```sh
sudo install -d -o astrama -g astrama -m 700 /etc/astrama
sudo -u astrama env BACKUP_KEY_FILE=/etc/astrama/private-backup-key node scripts/backup-stack.mjs backup --verify --init-key --compose compose.production.yaml --project astrama-production --env-file .env.production
```

Keep a second copy of that backup key in a separate secret vault; never copy it
into the offsite backup directory. Set the backup key and rclone configuration
files to mode `600`. Create `/opt/astrama/.local-backups` owned by the service
account with mode `700`.

Install the five unit files from `deploy/systemd/` under
`/etc/systemd/system/`, then enable the timers:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now astrama-offsite-backup.timer astrama-host-watch.timer
```

The daily backup captures and verifies the database, object store, and
application key, copies encrypted snapshots to the remote, checks the copied
files, then applies the retention period. A failed backup or offsite check
triggers an email alert. The five-minute host watcher alerts when root disk
usage reaches 80 percent or the live certificate has fewer than 14 days left.
Configure a separate external HTTPS uptime monitor for the public hostname;
this cannot alert if the host or its internet connection is down.

## Replacement-host restore drill

Use a second clean Linux VM with Docker Compose, Node 24, rclone access to the
backup prefix, and the separately retrieved backup key. Copy the production
release directory and `.env.production` with mode `600`, pull the exact
`RELEASE_TAG` images, then copy one encrypted verified backup directory from
the remote into `.local-backups/`. Run:

```sh
BACKUP_KEY_FILE=/etc/astrama/private-backup-key node scripts/backup-stack.mjs restore --verify --backup .local-backups/backup-<timestamp>-<id> --compose compose.production.yaml --project astrama-production --env-file .env.production
```

Record the release tag, backup timestamp, restore result, and elapsed time. The
verification restores into isolated temporary database and object-store
volumes; it never overwrites a live stack. This drill has not yet been run on a
separate host and must be recorded before declaring CX-07 operationally
validated.
