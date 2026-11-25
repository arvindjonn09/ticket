# Self-service signup, subdomains and operator console

Status: proposed design, 17 November 2026. Author: Claude (review/design). Implementer: Codex.
Owner decisions marked **OD-n** are open. Build everything behind configuration
so the work is not blocked, but do not choose a value for an OD yourself. Use
test-mode/placeholder values and label them "proposed" in the UI.

Before you start, add this as section 25 of `update-plan.md` (plan is the source
of truth), and record the deployment change below as an ADR.

## Goal

A company buys Astrama on our website and within a minute gets
`https://<their-name>.<our-domain>` with an admin invite in their inbox. The
organisation is pre-loaded with working defaults (departments, categories, SLA
targets, email settings off) and works the way the product is already designed.
Our own team has an internal console to help customers without reading their
tickets.

## Deployment change (ADR required)

D4 assumed one stack moved to one machine. Selling with subdomains means **one
shared hosted stack serving many organisations**. The existing design already
supports this (tenant_id everywhere, RLS, non-owner runtime role), so this is a
hosting change, not a rewrite. A single-company self-hosted install stays
possible with `PLATFORM_MODE=single`, which skips the signup, billing and
console and keeps today's behaviour.

## What already exists (reuse, do not rebuild)

- `tenants.slug` (unique). Use it as the subdomain.
- `apps/api/src/provision.ts`: transactional tenant + inactive admin + 48-hour
  invitation. Turn it into a service function that both the CLI and the signup
  job call.
- `apps/api/src/operator-data.ts`: audited export/delete with reason and
  evidence. The console calls these; do not reimplement them.
- Invitation mail, MFA recovery, SLA proposed defaults, seed data.

## Packets (do in order; each must pass full CI and gitleaks before push)

### SA-01 — Subdomain tenancy

Each organisation is served on its own subdomain; the host decides the tenant.

- Config: replace the single `APP_ORIGIN` with `APP_BASE_DOMAIN` (for example
  `astrama.example`) plus `PUBLIC_SITE_ORIGIN` and `OPERATOR_ORIGIN`. Keep
  `APP_ORIGIN` working when `PLATFORM_MODE=single`.
- Resolve the tenant from the `Host` header (`<slug>.<base>`). Unknown or
  inactive slug returns a neutral "organisation not found" page. Never reveal
  whether a slug exists through timing or different errors.
- Login: the organisation field is filled from the host and hidden. The API
  rejects a login whose `organisation` disagrees with the host.
- Sessions: the cookie stays host-only (no `Domain=` attribute), so one subdomain
  never receives another's cookie. In addition, the session guard denies a
  session whose tenant does not match the host tenant.
- CSRF/origin check: the expected origin is `https://<host tenant slug>.<base>`.
- Every link the system builds (invites, notifications, recovery, email
  auto-reply) uses the tenant's own origin. Search for all `APP_ORIGIN` uses.
- Reserved slugs that can never be taken: `www, app, api, admin, ops, mail,
smtp, imap, status, support, help, billing, docs, static, assets, cdn, auth,
login, signup, staging, dev, test`, plus anything in a configurable list.
- TLS: Caddy **on-demand TLS** with an `ask` endpoint
  (`GET /internal/tls-allowed?domain=`). The endpoint returns 200 only for an
  active tenant subdomain, the public site and the operator host. This needs no
  DNS-provider plugin. Rate-limit it. Wildcard DNS `*.base` points at the host.
- Tests: tenant A's session cookie sent to tenant B's host is denied. Login with
  a mismatched organisation is denied. A link in a tenant B notification points
  at B's subdomain. An unknown host gets the neutral page. The `ask` endpoint
  refuses unknown names.

### SA-02 — Organisation lifecycle, plans and starter template

- Tenant fields: `status` (`trial | active | read_only | deleted`),
  `readOnlyReason` (`trial_ended | payment_failed | cancelled | operator`),
  `trialEndsAt` (signup + 15 days), `readOnlySince`, `deleteAfter`
  (`readOnlySince` + 45 days), `seatLimit` and `planId`. Add the migration and
  seed. Every status change writes an append-only audit row.
- A scheduled job (fixed-clock testable) moves `trial` to `read_only` at
  `trialEndsAt`. It sends the deletion warnings at 30, 7 and 1 day before
  `deleteAfter`, and runs deletion at `deleteAfter`. Deletion re-checks status
  inside the job, so a payment that arrives in the meantime wins.
- Enforcement (server-side, central, default deny):
  - `trial` and `active` run normally. Trial admins see a banner counting down
    the days left.
  - `read_only` allows sign-in, viewing, reports and export only. Block every
    write endpoint with one guard check, not per-endpoint code. Blocked writes
    return a clear 403 message pointing admins to billing.
  - In `read_only`, email intake stops and outbound mail goes to admins only.
    Users see a banner with the deletion date.
  - `deleted` returns the neutral "organisation not found" page.
  - Workers (SLA, notifications, inbound, automation) already recheck tenant
    status. Extend that check to these states.
- Seat limit: inviting or activating a user beyond `seatLimit` returns a clear
  error that admins can see. Counting active humans excludes the system
  "Email intake" user.
- Starter template: a versioned JSON file, not hard-coded in services. It holds
  the departments (IT Support, Application Support, Infrastructure, Security per
  §24), a starter category set mapped to them, proposed SLA targets, business
  hours from the signup timezone, and email intake off. Provisioning applies it
  in the same transaction. The first customer's own data stays in seed only.
- Tests: table-driven allowed actions per status. Exceeding the seat limit is
  denied. A provisioned tenant can raise and route a ticket immediately.

### SA-03 — Signup, payment and automatic provisioning

- Payment provider adapter with a `test` implementation used by CI. Provider is
  **OD-2**; build the first real adapter for it after the decision. Stripe
  (`stripe`, MIT) and Paddle (`@paddle/paddle-node-sdk`, Apache-2.0) both fit
  rule 10.
- Flow:
  1. Signup form: company name, wanted subdomain (live availability check), admin
     name and email, timezone, plan.
  2. Verify the email address by link, which blocks typo-squatting and spam
     signups. Verification starts provisioning with a 15-day `trial` and no card
     (OD-4).
  3. Payment happens later from the in-app Billing page (Stripe Checkout), at
     any time during the trial or while read-only. We never handle card data.
  4. Provider webhook (`checkout completed` / `subscription updated` / `payment
failed` / `cancelled`). Verify the signature over the **raw body** (reuse the
     inbound-mail raw-body pattern). Store the provider event id, unique, so
     replays are no-ops.
  5. A committed outbox event starts a provisioning job via pg-boss. The job is
     idempotent on the checkout id, so a retry or duplicate webhook creates
     exactly one organisation. The slug is reserved at email verification, with
     expiry, so two buyers cannot both pay for the same name.
  6. Send the admin invite with a link to `https://<slug>.<base>/#activate...`.
     The success page says "check your email" and links to the subdomain.
- Admin "Billing" page inside the tenant shows plan, seats used/limit, status,
  and a link to the provider's hosted customer portal (change card, cancel,
  invoices). No card UI of our own.
- Abuse: per-IP and per-email signup rate limits, disposable-domain blocklist
  (configurable), CAPTCHA hook left as an adapter (**OD-7**).
- Tests (fixed clock):
  - A duplicate verification link or webhook creates one tenant or one
    subscription change.
  - A bad signature is rejected.
  - Day 15 → `read_only`, where every write endpoint is denied and export works.
  - Paying while read-only → `active`.
  - Final payment failure → `read_only`.
  - Day 45 → deleted. A payment on day 44 prevents deletion.
  - Warning emails go out at 30, 7 and 1 day.
  - Two concurrent signups for the same slug → one wins.
  - A failed CAPTCHA blocks signup.

### SA-04 — Public website

- A separate small static app (`apps/site`, Vite, same i18n/WCAG rules) served on
  `PUBLIC_SITE_ORIGIN`. Pages: home, pricing (plans from config, **OD-3**),
  signup (SA-03 form), signup success, "find my organisation" (we email the
  subdomain links for an address, without revealing on screen whether it
  exists), terms and privacy placeholders (**OD-6**, owner/lawyer supplies text).
- No customer data is served from this app. It only calls the public signup API.
- Playwright journey: visitor → pricing → signup → verify email (Mailpit) →
  test checkout → invite email → activate on subdomain → raise first incident.
  This is the fifth E2E journey.

### SA-05 — Operator console (our internal tool)

Served only on `OPERATOR_ORIGIN` (for example `ops.<base>`), a separate SPA
workspace.

- **Identity:** a separate `operators` table, not tenant `users`, because
  operators belong to no tenant. MFA is mandatory (reuse TOTP; passkeys later),
  sessions are short (15 minutes idle), and an optional IP allowlist is set in
  config. No self-signup: the first operator is created by CLI.
- **Roles:** `support` (view and help) and `owner` (plus billing changes,
  suspend, delete).
- **Database access:** the runtime role keeps no BYPASSRLS. Cross-tenant reads go
  through `SECURITY DEFINER` functions that return metadata and counts only. This
  follows the pattern of `pending_sla_tenants()`.
- **Features:**
  - Organisation list and search: name, slug, status, plan, seats used/limit,
    created, last activity.
  - Organisation detail:
    - Health: outbox backlog, failed jobs, last email delivered or failed,
      inbound queue, storage used.
    - Admin contacts and timeline of status, plan and audit events.
  - Actions, each requiring a typed reason and writing an operator audit row:
    - resend admin invite;
    - start the existing verified admin MFA recovery;
    - extend trial;
    - change plan or seat limit (owner);
    - suspend/reactivate (owner);
    - run export (wraps `operator-data.ts`);
    - schedule deletion (owner, double confirmation with the slug typed).
  - Platform health: queue depths, error rates, certificate expiry, backup age
    (reuse the existing operations monitor).
- **Support access (plan rule: no ticket content without an explicit audited
  grant):**
  - Operators cannot see tickets by default.
  - A tenant admin can grant time-limited access (for example 24 hours) to a
    named operator from inside their organisation settings. The grant is shown
    to the admin, and the admin can revoke it at any time.
  - The operator then has a read-only, audited view. Every page view is logged
    and visible to the tenant admin.
  - Internal work notes follow the same audience rules as for agents.
- **Tests:**
  - An operator without a grant gets 403 on any ticket endpoint.
  - With a grant, access is read-only and expires on time.
  - Every action writes an audit row.
  - An operator session is not accepted on a tenant host and vice versa.
  - A support-role operator cannot suspend or delete.

### SA-06 — Hosted production setup

- Wildcard DNS and Caddy on-demand TLS (SA-01). Public site, operator host and
  tenant hosts are served from one Caddy.
- Backups and restore cover all tenants. Add a single-tenant restore procedure,
  rebuilt from the export, and test it.
- Fairness limits per tenant, so one customer cannot slow others: request rate,
  upload size/day, inbound mail/hour, export frequency.
- Monitoring alerts are tagged by tenant slug.
- Status page (Uptime Kuma, already proposed).
- Update `docs/install.md` for hosted mode. Keep the single-company mode
  instructions.

## Owner decisions (answered 17 November 2026)

- **OD-1 Domain and region — deferred until the app is built.** Keep
  `APP_BASE_DOMAIN` as config. Use `astrama.test` locally and in CI.
- **OD-2 Payment provider — Stripe** (`stripe` npm, MIT). Keep the provider
  adapter so another provider can be added later. Build only the Stripe adapter
  plus the CI `test` adapter. Use Stripe Checkout, the Customer Portal and Stripe
  Tax settings; we never handle card data.
- **OD-3 Prices — decided per customer.** Do not hard-code plans or prices on
  the website or in code.
  - The operator console sets each organisation's Stripe price id, seat limit
    and billing interval.
  - The public pricing page shows "Contact us / Start free trial", with no price
    table, until plans are configured.
  - Plans live in a config table that operators can edit, with an audit row per
    change.
- **OD-4 Trial — 15 days.** After it ends without payment, the organisation
  becomes **read-only**:
  - users can sign in, view tickets and reports, and export;
  - they cannot create or edit anything (tickets, messages, uploads, approvals,
    configuration, users);
  - email intake stops, and outbound mail goes to admins only (billing
    reminders).

  Paying at any time restores full access immediately.

  _Reviewer interpretation, confirm with owner:_ no card is needed to start the
  trial, so the organisation is provisioned right after email verification.
  Failed payments use the same read-only rule after Stripe's final retry.

- **OD-5 Deletion — 45 days.** An organisation that stays read-only for 45 days
  (unpaid trial, final payment failure, or cancellation) is deleted with the
  existing audited deletion.
  - Admins are emailed at 30, 7 and 1 day before deletion, and the banner shows
    the deletion date.
  - Admins can export during the whole period.
  - Paying before day 45 cancels the deletion.
  - An operator `owner` can extend the period with a reason.
- **OD-6 Legal text — at go-live.** Ship placeholder pages and a signup
  checkbox; the owner supplies text before production.
- **OD-7 CAPTCHA — yes.** Use **ALTCHA** (`altcha` / `altcha-lib`, MIT). It is a
  self-hosted proof-of-work check with no third-party service or tracking
  cookies, so there is no extra privacy-policy entry. Verify server-side on
  signup, "find my organisation" and resend-verification. Keep the adapter so a
  hosted CAPTCHA can replace it if bots get through. Licence-check before adding.

- **OD-8 Initial support staffing — confirmed 18 November 2026.** An active administrator who belongs to a support group may support tickets in that group, with the same membership, MFA and sensitive-ticket restrictions as agents. New organisations place their initial administrator in the starter triage queue so the first ticket can route after activation.

## Out of scope for now

Customer-owned custom domains (`help.theircompany.com`), SSO, and per-tenant
email domains. Leave the host-resolution code able to add a `custom_domains`
lookup later, but do not build it.
