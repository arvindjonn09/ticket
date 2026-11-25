# Test the application locally

The normal app is at [http://localhost:4310](http://localhost:4310), using the
existing local data. Its mailbox is [localhost:4312](http://localhost:4312).
The 19 November update preserves the 23 existing tickets and MFA enrolments; it
does not rerun the demo seed against that database.

For the full signup, organisation and operator experience, use the separate
hosted sandbox. It has its own database, objects, mailbox and fictional accounts:

| What to test                              | Address                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Public site and new organisation signup   | [astrama.localhost:8443](https://astrama.localhost:8443)                     |
| Harbour employee/support/admin app        | [harbour.astrama.localhost:8443](https://harbour.astrama.localhost:8443)     |
| Second organisation, for isolation checks | [northstar.astrama.localhost:8443](https://northstar.astrama.localhost:8443) |
| Operator console                          | [ops.astrama.localhost:8443](https://ops.astrama.localhost:8443)             |
| Captured sandbox email                    | [localhost:14312](http://localhost:14312)                                    |

Use Chrome or Edge: `.localhost` resolves to your own computer without changing
the hosts file. The sandbox uses Caddy's private development certificate.
For these local test addresses only, use the browser's Advanced → proceed option
when it warns that the certificate is untrusted. No system trust certificate
is installed by setup. A managed browser that forbids local certificate
exceptions can still use the normal HTTP demo at localhost:4310.

## Fictional sandbox accounts

All sandbox accounts initially use **`Astrama-demo-2026!`**:

| Account              | Use                                                         |
| -------------------- | ----------------------------------------------------------- |
| `employee@demo.test` | Employee; available in Harbour and Northstar                |
| `agent@demo.test`    | Support agent; available in both organisations              |
| `admin@demo.test`    | Organisation administrator; available in both organisations |
| `owner@demo.test`    | Operator owner; sign in on the operator host                |

Agent, administrator and operator access requires real TOTP enrolment on first
sign-in. Use your authenticator app and keep its account. Setup does not bypass
MFA or reset an existing enrolment. The operator offers a scannable QR code and
"Can't scan?" manual setup secret/URI. These credentials and the test payment/CAPTCHA keys
are fictional local fixtures; never use them for a production deployment.

## Suggested test order

1. Sign in to Harbour as the employee. Report an issue and request a service.
2. Sign in as the agent, enrol MFA, claim the incident, add a customer reply and
   an internal note, and resolve it. Return as the employee and confirm that
   internal notes remain hidden.
3. Sign in as the administrator, enrol MFA, and try user invitations, support
   groups, categories, request approval policies and routing preview. Open
   invitation/reset messages in the sandbox mailbox.
4. Sign in to Northstar and confirm that Harbour's records are unavailable.
5. Open the public site and create your own test organisation. Follow its email
   verification and activation links in the sandbox mailbox, then enrol MFA.
   The initial administrator belongs to its starter triage group and can handle
   the first incident.
6. Enrol the operator account. Inspect organisation metadata, then explicitly
   grant that named operator temporary access from the organisation admin's
   Operator support access section. Verify read-only support and revoke it.

## Simulated billing, without Stripe or a card

The sandbox has a fictional `local-monthly` plan. Checkout uses the test provider
and ends at a placeholder URL; simulate its signed webhook from a terminal:

```powershell
docker compose -f compose.hosted-local.yaml exec -T lifecycle node apps/api/dist/local-demo.js billing harbour activate
docker compose -f compose.hosted-local.yaml exec -T lifecycle node apps/api/dist/local-demo.js billing harbour payment_failed
docker compose -f compose.hosted-local.yaml exec -T lifecycle node apps/api/dist/local-demo.js billing harbour activate
```

Replace `harbour` with your test organisation slug. Refresh its Billing page
after each command to check active/read-only/recovered behaviour. `cancelled`
is also accepted. The tool refuses production/provider settings and manually
held organisations; it does not contact Stripe or charge a card.

## Start, stop and update

Docker Desktop must be running in Linux-container mode. From the repository:

```powershell
docker compose -f compose.hosted-local.yaml up --build -d
docker compose -f compose.hosted-local.yaml ps
docker compose -f compose.hosted-local.yaml stop
```

Use `up -d` to restart without rebuilding. Database/object/MFA state persists in
named volumes. The setup service refreshes fictional demo passwords when it
runs; it preserves enrolled MFA. Do not delete volumes to update the app.
Keep the existing ignored `.env` encryption key stable and private.

The normal local installation uses `docker compose` without the extra file.
Both installations bind published ports only to loopback. Tests do not send
real email. Real Stripe/SMTP/offsite credentials, production DNS/legal text,
customer allowances and clean-host deployment drills remain launch inputs.
