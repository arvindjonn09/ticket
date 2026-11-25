# Production deployment

The production Compose stack provides Caddy-managed HTTPS with automatic certificate renewal, separate database owner/runtime credentials, a non-root API/worker with a read-only filesystem, private database/object/scanner services, authenticated TLS email and operational checks. Actual hosting, DNS, SMTP credentials, offsite backup destination and customer pilot remain deployment inputs. The local demo is not a production installation.

## Prepare a host and configuration

Use a Linux host with Docker Compose and Node 24, sufficient storage for data and a full independent restore, and firewall access for HTTP, HTTPS and operator administration. Point the chosen DNS hostname at it. Caddy obtains and renews certificates automatically; ports 80 and 443 must be reachable from the public internet. Keep the Caddy data and config volumes in host backup scope.

Copy `.env.production.example` to a private `.env.production` file, set its permissions to `600`, and fill every required value. Generate independent random database, storage and application keys; never reuse the local demo values. Keep `MFA_ENCRYPTION_KEY` stable across releases and back it up separately. Database passwords use URL-safe characters; a random hexadecimal value is suitable. Use authenticated SMTP on 587 with `SMTP_SECURE=false` (mandatory STARTTLS), or 465 with `SMTP_SECURE=true`. Verify the sender/domain with the mail provider. Set a real operator alert mailbox.

Run from this checkout:

```sh
node scripts/check-production.mjs .env.production
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml pull
docker compose --env-file .env.production -f compose.production.yaml up -d db storage scanner setup
docker compose --env-file .env.production -f compose.production.yaml up -d --wait api worker web
```

Setup bootstraps restricted database roles and applies ordered migrations without demo seeding. The API and worker do not receive the owner connection or owner password. Database, scanner and object storage have no public host ports. Mount the TLS directory read-only; never bake private files into an image. Preserve the previous release images before upgrading.

## First organisation

Follow [organisation provisioning](operations.md#provision-a-new-organisation) using an explicit private organisation JSON file and the setup/operator environment. In the setup image the command is `node apps/api/dist/provision.js`; in the production API image it is `node dist/provision.js`. Supply the owner URL only to the one-off operator process, never the running API/worker. The administrator receives a one-use activation link, chooses their password, enrolls MFA using the QR code, then creates users, groups, category/subcategory routes and catalogue policies.

Automation is disabled until that organisation enables its chosen business days, holidays and delays. Retention does not delete data until explicit periods are configured; legal holds block the supported deletion operations. Review these settings with the customer. Custom third-party integrations require that customer's actual provider, credentials and workflow; there is no assumed integration or unrestricted plugin execution.

## Health, alerts and backups

The MFA-verified administrator can inspect **Organisation setup → Service health**. Docker checks API/database connectivity and worker heartbeats. The operator command checks database, worker freshness, queue backlog/failures, storage, scanner and a successful verified backup within 26 hours:

```sh
docker compose --env-file .env.production -f compose.production.yaml --profile operations run --rm --no-deps monitor
```

The monitor exits nonzero on failure and sends a generic component-only email to `OPERATOR_ALERT_EMAIL`. Install the host watcher described in [install.md](install.md); it checks filesystem usage and the live HTTPS certificate and invokes this monitor with those measurements. Schedule it every five minutes and also use an independent external HTTPS uptime monitor; an in-stack check cannot report a completely failed host or mail provider. Repeated failures send repeated alerts, so route them to the operator's incident mailbox. Keep scheduler logs private.

Use [encrypted full backup and restore verification](backup-recovery.md) through the offsite backup script. Schedule daily capture in an agreed maintenance window because capture briefly stops writers. The script copies only verified encrypted snapshots to the configured rclone remote and applies the configured retention period. Keep the backup decryption key in a separate secret vault. Verify offsite access and perform a replacement-host restore before accepting a recovery-time commitment. Provider credentials are deployment inputs and are never put in the image or repository.

See [account recovery and key rotation](recovery.md) and [tenant export, retention and deletion](data-lifecycle.md) for explicit operator commands. Identity evidence is required for lost-MFA recovery; possession of an email address is insufficient.

## Release and recovery checks

Before rollout, run CI and the Chromium/Firefox/WebKit journeys, take a verified complete backup, confirm disk space, apply migrations with setup, and start the new API/worker/web images. Check public HTTPS, certificate trust, secure session cookies, invitation/recovery mail delivery, worker and scanner health, then run the customer pilot with realistic queue and permission assignments. Schedule host security updates and certificate renewal.

Do not reverse migrations or overwrite live volumes to roll back. First establish whether the old code supports the new schema; otherwise restore the verified database, object volume and application key together into a separate maintenance destination, remove the documented verification fixture, validate access and then cut traffic over. The backup verifier deliberately has no live-overwrite option. Record the actual recovery point/time and any writes after the snapshot.

## Platform email deployment

Testing uses Mailpit in CI and the open-source `mail-oss` profile described in
[the mail specification](specs/custom-domain-and-email.md). Paid relays are
configured later; no live provider or domain ownership is assumed here.

Set `PLATFORM_MAIL_DOMAIN` to the domain authorised by the sending server.
If omitted, its bootstrap value comes from the domain in `SMTP_FROM`.
Tenant notifications use `"<Brand> Support" <notifications@<domain>>`; Message-ID
uses the same domain. Set `INBOUND_MAIL_DOMAIN` to the domain routed to intake;
hosted mode can derive `in.<APP_BASE_DOMAIN>`. Ticket replies use a tokenised
tenant address. Keep platform sender credentials in the private environment
until operator-managed profiles are enabled. Never commit credentials or DKIM
private keys.

Set an explicit positive `TENANT_OUTBOUND_PER_HOUR` allowance before hosted
production startup. It applies atomically across workers to tenant sending
attempts, including invitations, recovery and lifecycle notices. An exhausted
allowance defers existing durable work for retry. SMTP acknowledgement can be
ambiguous; delivery is not exactly once. Organisation → Email health shows
tenant-scoped deliveries, failures, queued work and current-hour usage.

### DNS checklist

Replace each placeholder with values supplied by the configured sending server.
Publish one SPF record per domain, merging existing authorised senders.

| Record | Name                                                | Value to configure                                                                           |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TXT    | `<platform mail domain>`                            | `v=spf1 <authorised relay include or ip4/ip6 mechanisms> -all`                               |
| TXT    | `<DKIM selector>._domainkey.<platform mail domain>` | `v=DKIM1; k=rsa; p=<public key supplied by the sender>`                                      |
| TXT    | `_dmarc.<platform mail domain>`                     | `v=DMARC1; p=quarantine; rua=mailto:<owner-approved reporting mailbox>` (or stricter policy) |
| MX     | `<inbound mail domain>`                             | `<priority> <public hostname of mail-intake>`                                                |

Configure envelope-sender/SPF alignment and DKIM signing for the From domain.
Check a delivered message's authentication results for SPF, DKIM and DMARC;
verify that replying reaches the correct tenant and ticket. The DNS names,
public keys, relay mechanisms, reporting address, domain and hosting region
remain deployment inputs. Legal text, tax setup and custom web domains are
deferred.
