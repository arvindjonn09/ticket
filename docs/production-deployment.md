# Production deployment

The production Compose stack provides HTTPS, separate database owner/runtime credentials, a non-root API/worker with a read-only filesystem, private database/object/scanner services, authenticated TLS email and operational checks. Actual hosting, DNS, a trusted certificate, SMTP credentials, offsite backup destination and customer pilot remain deployment inputs. The local demo is not a production installation.

## Prepare a host and configuration

Use a Linux host with Docker Compose, Node 24, sufficient storage for data and a full independent restore, and firewall access limited to HTTPS, HTTP certificate renewal and your operator access. Point the chosen DNS hostname at it. Obtain a trusted certificate for that hostname; put `fullchain.pem` and `privkey.pem` in an absolute directory outside the checkout, available only to the operator. Arrange certificate renewal and reload nginx after replacement.

Copy `.env.production.example` to a private `.env.production` file, set its permissions to `600`, and fill every required value. Generate independent random database, storage and application keys; never reuse the local demo values. Keep `MFA_ENCRYPTION_KEY` stable across releases and back it up separately. Database passwords use URL-safe characters; a random hexadecimal value is suitable. Use authenticated SMTP on 587 with `SMTP_SECURE=false` (mandatory STARTTLS), or 465 with `SMTP_SECURE=true`. Verify the sender/domain with the mail provider. Set a real operator alert mailbox.

Run from this checkout:

```sh
node scripts/check-production.mjs .env.production
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml build
docker compose --env-file .env.production -f compose.production.yaml up -d db storage scanner setup
docker compose --env-file .env.production -f compose.production.yaml up -d --wait api worker web
```

Setup bootstraps restricted database roles and applies ordered migrations without demo seeding. The API and worker do not receive the owner connection or owner password. Database, scanner and object storage have no public host ports. Mount the TLS directory read-only; never bake private files into an image. Preserve the previous release images before upgrading.

## First organisation

Follow [organisation provisioning](operations.md#provision-a-new-organisation) using an explicit private organisation JSON file and the setup/operator environment. In the setup image the command is `node apps/api/dist/provision.js`; in the production API image it is `node dist/provision.js`. Supply the owner URL only to the one-off operator process, never the running API/worker. The administrator receives a one-use activation link, chooses their password, enrolls MFA using the QR code, then creates users, groups, category/subcategory routes and catalogue policies.

Automation is disabled until that organisation enables its chosen business days, holidays and delays. Retention does not delete data until explicit periods are configured; legal holds block the supported deletion operations. Review these settings with the customer. Custom third-party integrations require that customer's actual provider, credentials and workflow; there is no assumed integration or unrestricted plugin execution.

## Health, alerts and backups

The MFA-verified administrator can inspect **Organisation setup → Service health**. Docker checks API/database connectivity and worker heartbeats. The operator command checks database, worker freshness, queue backlog/failures, storage, scanner and a successful verified backup within 48 hours:

```sh
docker compose --env-file .env.production -f compose.production.yaml --profile operations run --rm --no-deps monitor
```

The monitor exits nonzero on failure and sends a generic component-only email to `OPERATOR_ALERT_EMAIL`. Schedule it every five minutes on the host and also use an independent external HTTPS uptime monitor; an in-stack check cannot report a completely failed host or mail provider. Repeated failures send repeated alerts, so route them to the operator's incident mailbox. Keep scheduler logs private.

Use [encrypted full backup and restore verification](backup-recovery.md), selecting `--compose compose.production.yaml --project astrama-production --env-file .env.production`. The backup discovers the running stack's configuration; it does not require printing private environment values. Schedule daily capture in an agreed maintenance window because capture briefly stops writers. Only a successful isolated database, object and key restore marks the backup healthy. Copy completed encrypted artifacts and the exact release images offsite, with the backup decryption key in a separate secret vault. Verify that destination and perform a replacement-host restore before accepting a recovery-time commitment. No external storage credentials are invented or configured automatically.

See [account recovery and key rotation](recovery.md) and [tenant export, retention and deletion](data-lifecycle.md) for explicit operator commands. Identity evidence is required for lost-MFA recovery; possession of an email address is insufficient.

## Release and recovery checks

Before rollout, run CI and the Chromium/Firefox/WebKit journeys, take a verified complete backup, confirm disk space, apply migrations with setup, and start the new API/worker/web images. Check public HTTPS, certificate trust, secure session cookies, invitation/recovery mail delivery, worker and scanner health, then run the customer pilot with realistic queue and permission assignments. Schedule host security updates and certificate renewal.

Do not reverse migrations or overwrite live volumes to roll back. First establish whether the old code supports the new schema; otherwise restore the verified database, object volume and application key together into a separate maintenance destination, remove the documented verification fixture, validate access and then cut traffic over. The backup verifier deliberately has no live-overwrite option. Record the actual recovery point/time and any writes after the snapshot.
