# Upgrade and rollback

## Upgrade

Read the release notes for migration compatibility and required operator
actions. Confirm free disk space, a recent verified backup, and off-host copies
of encrypted database, attachment, key, and release-image artifacts. Preserve
the currently deployed release tag. Then set `RELEASE_TAG` in the private
`.env.production` file to the new version-and-commit tag and run:

```sh
docker compose --env-file .env.production -f compose.production.yaml pull
docker compose --env-file .env.production -f compose.production.yaml up -d db storage scanner setup
docker compose --env-file .env.production -f compose.production.yaml up -d --wait api worker web
```

The one-off `setup` service applies ordered Prisma migrations before the new
API and worker start. Check container health, HTTPS, SMTP delivery, scanner,
worker heartbeat, and a representative ticket workflow. Keep the prior images
available until the release is accepted.

## Rollback

First check the release notes and schema compatibility. If the old release
supports the migrated schema, restore the previous `RELEASE_TAG` and restart
the services. If not, do not run old code on the new schema: restore the
verified database, attachment volume, and matching encryption/storage key
material together to a separate maintenance destination, validate it, then
cut traffic over. Never overwrite the live volumes during a rollback rehearsal.
Record the recovery point and any writes that must be reconciled. The backup
and restore procedure is in [backup-recovery.md](backup-recovery.md).
