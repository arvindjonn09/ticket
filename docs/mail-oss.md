# Test mail with Mox and the Astrama intake

This testing profile uses open-source Mox for authenticated sending, the Astrama
`mail-intake` process for receiving, and Mailpit to capture other mail. No paid
provider is needed. It uses a separate Compose project, database and volumes;
the existing normal and hosted sandboxes can keep running.
Its application images use the separate `astrama-mail-oss-api:local` and
`astrama-mail-oss-web:local` tags, so building it does not replace the normal
sandbox's API or web images.

```powershell
docker compose -f compose.hosted-local.yaml -f compose.mail-oss.yaml --profile mail-oss up --build -d
docker compose -f compose.hosted-local.yaml -f compose.mail-oss.yaml --profile mail-oss ps
```

The default project is `astrama-mail-oss`. Its application is at
`https://harbour.astrama.localhost:18443`, operator console at
`https://ops.astrama.localhost:18443`, and captured mailbox at
`http://localhost:14313`. The existing fictional sandbox accounts and browser
certificate instructions are in [local testing](local-testing.md). Set
`MAIL_OSS_HTTPS_PORT` and `MAIL_OSS_MAILPIT_PORT` before starting if those ports
are already occupied. No Mox, intake, database or IMAP port is published.

The existing ignored `.env` must contain an MFA encryption key. Preserve it
across restarts because the application encrypts saved SMTP credentials with it.
`MAIL_OSS_DOMAIN` defaults to the synthetic testing domain `astrama.localhost`;
set it before the first start to test another mail domain. Changing it later
requires a fresh isolated project so existing credentials are never silently
replaced. This choice does not configure a real production domain or DNS.

## Activate sending through the operator console

The bootstrap creates a random SMTP password, signing key and private testing
CA in `mail-oss-private`. Private directories have mode 0700 and the credential
file has mode 0600. Only Mox and its one-time bootstrap mount that private volume.
API and workers receive a different volume containing only the public CA
certificate through `NODE_EXTRA_CA_CERTS`; ordinary public CA trust remains
enabled. TLS certificate and hostname verification are required.

To retrieve the generated settings without printing them to terminal history:

```powershell
New-Item -ItemType Directory -Force secrets | Out-Null
docker compose -f compose.hosted-local.yaml -f compose.mail-oss.yaml --profile mail-oss cp mox:/mox/private/smtp-profile.json secrets/mail-oss-profile.json
```

Keep that ignored file private. On a shared Windows computer, restrict its
Security permissions to your own account before opening it. On Linux/macOS,
use `chmod 600 secrets/mail-oss-profile.json`. Never put the file in an issue,
chat message, screenshot or commit. Remove the exported copy after entering
the settings; the private volume retains the original for recovery.

1. Sign in to the operator console as the owner and complete MFA normally.
2. Open **Platform email → Sending**, select **Self-hosted (mox)**, and enter
   the username and password from the private JSON file. Host is `mox`, port
   `587`, security **STARTTLS**. The generated From address is
   `notifications@<MAIL_OSS_DOMAIN>`; use the matching From domain.
3. Send a test email to the operator. It should appear in Mailpit.
4. Activate the tested profile, supplying the required MFA and audit reason.
   New sends pick up the active revision without restarting API or workers.
5. Use **Roll back** with MFA and a reason to return to the previous tested
   profile when needed. Bootstrap Mailpit remains the initial fallback until
   an operator activates a profile.

No profile is automatically activated by Compose or by the infrastructure test.
Later, entering another generic SMTP profile, testing it, and activating it in
the same screen switches to a paid relay without a redeploy. Customer-owned
SMTP settings remain separate.

## Receiving and routing

Mox runs its normal `serve` command. Its only enabled network listener is
authenticated SMTP submission on port 587 with STARTTLS required. Mox's
incoming port 25, IMAP, webmail and HTTP/HTTPS listeners are disabled. Mox's
`localserve` mode is not used: that mode redirects deliveries back to itself
and cannot verify the actual intake path.

Mox's explicit queue routes send `*@in.<MAIL_OSS_DOMAIN>` to
`mail-intake:2525`. The intake checks the actual SMTP recipient against active,
tenant-owned address mappings and returns 550 for unknown addresses. Configure
the organisation's triage route and forwarding address in **Settings → Email**
before sending to it. An authenticated Mox submission can be queued before an
unknown downstream recipient is rejected; 550 refusal happens at the intake's
RCPT command.

All other destination domains go to Mailpit at `mail:1025`. Mox connects only to
an internal Docker network, and no route performs Internet delivery. The two
unauthenticated internal delivery hops carry test messages inside that isolated
network; application-to-Mox credentials always travel over verified STARTTLS.
Local `.localhost` DNS does not authenticate email, so real intake authentication
results remain unverified. No forged authentication headers or DNS bypasses are
used. The existing intake applies its normal unverified-sender handling.

Mox signs outbound mail using the generated DKIM key. Production DNS, reputation,
reverse DNS, production TLS certificates and delivery to public mailboxes are
separate deployment work; this local profile does not claim public deliverability.

## Automated disposable verification

With Docker and Node 24 available, run:

```powershell
node scripts/test-mail-oss.mjs
```

The script builds the API from an immutable Git `HEAD` archive, not from other
workers' uncommitted files. To reuse a previously built image from that snapshot,
set `MAIL_OSS_TEST_API_IMAGE` explicitly. The check creates random resource names,
an internal network and fresh volumes, publishes no host ports, and removes only
its own containers, volumes, network and temporary bootstrap image in `finally`.
The reusable API image is retained.

It prepares a restricted PostgreSQL runtime role, applies migrations, seeds one
disposable tenant and mapped inbox, and checks:

- verified SMTP STARTTLS and authentication, plus rejection of an untrusted CA,
  wrong credentials and unauthenticated relay;
- actual `Mox serve → mail-intake → PostgreSQL` delivery, with one queued row
  associated with the configured tenant and real unverified DNS results;
- an unknown intake recipient refused with 550 during RCPT;
- other mail captured by Mailpit and the queued message retained after intake
  restart.

The receiver receives only the restricted runtime connection. Owner credentials
are used solely by disposable database setup and verification. This check proves
durable intake, not attachment scanning or ticket processing; those are covered
by the existing real-service workflow tests.

Stop this sandbox without deleting its settings or data:

```powershell
docker compose -f compose.hosted-local.yaml -f compose.mail-oss.yaml --profile mail-oss stop
```

Mox is pinned to the official v0.0.17 image digest
`sha256:8889e7b48fdd5b0b07b51dd11a6d06536334ec442652f2ffb1e1df3a9d45074e`.
The configuration follows the versioned binary's `config describe-static`,
`config describe-domains` and `help setaccountpassword` output, with the
[official deployment example](https://github.com/mjl-/mox/blob/main/docker-compose.yml)
and [localserve source](https://github.com/mjl-/mox/blob/main/localserve.go) explaining
the distinction between real queue delivery and localserve.
