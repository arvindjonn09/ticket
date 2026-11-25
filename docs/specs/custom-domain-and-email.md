# Customer domains, customer email and launch readiness

Status: proposed design, 24 November 2026. Author: Claude (review/design).
Implementer: Codex. Add this as section 26 of `update-plan.md` before starting.
Owner decisions (**OD-n**) are open. Build behind configuration and do not
choose a value for an OD yourself.

## Step 0 — commit what exists first (blocking)

107 changed files (BL-01 to BL-04, SA-04, SA-05, SA-06) are still uncommitted.
The picomatch advisory was withdrawn on 18 November, so the audit gate passes
without suppression.

Commit in four commits (BL fixes, SA-04, SA-05, SA-06), push, and get CI and
gitleaks green. Remove the stale OpenCode worktrees and `C:/temp/astrama-sa03-candidate`.
Nothing below starts until this is done.

## The real scenario

A company buys Astrama. From day one, with no setup, it has:

- `acme.astrama.com` working over HTTPS (built in SA-01);
- notification emails sent from the platform as "Acme Support"
  <notifications@astrama.com>, with replies threaded back into tickets;
- an inbound address it can forward its support mailbox to.

Later, from its admin settings, the company can optionally:

1. use its own web address, `help.acme.com` (CD-01);
2. send email from its own address, `support@acme.com` (EM-02 / EM-03);
3. receive its support mailbox's email as tickets (EM-01).

Each option has a step-by-step in-app guide showing the exact DNS records or
settings, a "Check now" or "Send test email" button, and a status of Not set up,
Pending, Working or Problem, with the reason in plain words.

---

## Owner direction, 24 November 2026 — keep the Astrama brand visible

The owner wants the Astrama name to stay visible to every end user, because
that builds product reputation.

- **CD-01 is deferred.** Do not build it now. Customers use
  `<slug>.astrama.com` only, so the brand is in every URL. Keep the design below
  for a possible later premium "white-label" option (owner decision when that
  comes up); `resolveHost` should stay easy to extend for it.
- **BR-01 (new, build now, small):**
  - Show "Powered by Astrama" in the tenant app footer, on the sign-in page and
    on the employee portal.
  - Add a one-line footer to every notification email: "Sent by Astrama
    ticketing", with a link to the public site that carries a referral tag such
    as `?ref=<slug>`.
  - Use i18n keys, pass WCAG contrast checks, and keep the text small and
    unobtrusive.
  - Add a plan feature flag `hideBranding`, default `false`, with no UI yet,
    so a white-label tier can be sold later without code changes.
  - Test: footer present by default in the app and in email; absent only when
    the flag is set.
- **EM-03 stays.** Customers sending from `support@acme.com` is normal and
  helps deliverability. The BR-01 email footer keeps the brand visible.

## CD-01 — Customer's own web address (deferred; reference design)

- Admin → Settings → Web address. The admin enters a hostname. Accept
  subdomains only (`help.acme.com`); reject apex domains (`acme.com`), because
  CNAME is not allowed at an apex. Apex support can come later if customers
  ask.
- The admin is shown two DNS records:
  - `CNAME help.acme.com → acme.astrama.com` (or a fixed target set in
    config, `CUSTOM_DOMAIN_TARGET`);
  - `TXT _astrama-verify.help.acme.com = <random token>`, which proves
    ownership.
- Table `custom_domains`: `tenant_id, hostname (unique, globally), token_hash,
status (pending|verified|failed|disabled), verified_at, last_checked_at,
failure_reason, is_primary`. One custom domain per tenant for now. Add a
  migration and seed it with none.
- A verification job uses `node:dns` (standard library) for both records. It
  checks every 5 minutes for 72 hours after the domain is added, then hourly.
  It re-checks verified domains daily. A domain whose records have been
  missing or wrong for 3 consecutive days is set to `disabled`, the tenant
  falls back to its slug address, and admins are emailed. This prevents
  stale-certificate and dangling-DNS takeover.
- Reject our own base domain and any subdomain of it, IP literals, `localhost`,
  hostnames already claimed by another tenant (same error as "invalid", so no
  enumeration), and the public-site and operator hosts.
- **Host resolution:** extend `resolveHost` to look up verified custom domains
  (SECURITY DEFINER function, like `resolve_active_tenant_host`). Extend the
  Caddy `ask` endpoint to allow verified custom domains only, so certificates
  are issued on first visit.
- **One canonical address:** once verified and marked primary, the custom
  domain becomes the tenant origin. Invite, notification and recovery links use
  it, and `acme.astrama.com` redirects there with a 308. Cookies stay host-only,
  and the session guard and origin check use the canonical host.
  Removing the domain switches back to the slug address. Existing sessions on
  the old host then end, and the UI says so in advance.
- Lifecycle: `read_only` keeps serving the domain. `deleted` removes the domain
  row.
- Operator console: show domain and status, "Re-check now", "Disable" (with a
  reason, audited).
- Audit every add, verify, disable and remove (config audit).
- **Tests (real PostgreSQL, stubbed DNS resolver):**
  - TXT mismatch → stays pending.
  - Verified → host resolves, `ask` allows it, links use it, the slug host
    redirects.
  - Records removed for 3 days → disabled and fallback.
  - Another tenant cannot claim a verified hostname.
  - A session from the slug host is rejected on the custom host.
  - Our base domain is rejected.

## EM-01 — Receiving email (customer's support mailbox → tickets)

The intake logic is built (CX-04). What is missing is a real provider.

- **Platform inbound provider (OD-8).** Write one adapter for the chosen
  provider's inbound webhook, mapped to the existing normalised message and
  raw-body signature check. Keep the test adapter for CI.
- Each tenant gets an inbound address on the platform inbound domain:
  `acme@in.astrama.com`. Department addresses use the existing mapping:
  `acme+it@in.astrama.com`. Reply tokens already use `+t.`; keep the two
  separators unambiguous and test both.
- In-app guide: "Forward support@acme.com to acme@in.astrama.com". Include
  instructions for Microsoft 365 (mail flow rule or mailbox forwarding;
  external forwarding must be allowed in the outbound spam policy) and Google
  Workspace (routing rule).
- A "Check now" button tells the admin to send a test email to their own
  support address and waits for it to arrive. It marks the address Working when
  a message arrives through forwarding.
- Forwarding note: forwarded mail usually fails SPF, but DMARC still passes
  through the original DKIM signature. The intake already uses DMARC only
  (PR-05). Test a forwarded fixture.
- Later, not now: connecting a mailbox directly with Microsoft Graph or IMAP
  (`imapflow`) polling, for customers who cannot forward.

## EM-02 — Sending email: default platform sender (works with no setup)

- Today one global nodemailer transport sends everything from `SMTP_FROM`. Keep
  that as the platform transport (OD-8 provider). Per tenant:
  - From: `"<Tenant brand> Support" <notifications@<platform mail domain>>`;
  - Reply-To: the tenant's tokenised inbound reply address;
  - Message-ID on the platform mail domain.
- The platform domain needs SPF, DKIM and DMARC (`p=quarantine` or stricter).
  Document the DNS records in `docs/production-deployment.md`. These are
  deployment inputs.
- Every send is attributed to a tenant (`tenant_id` on the delivery row), so
  per-tenant budgets (SA-06) and the admin "Email health" page work.

## EM-03 — Sending email: customer's own address

Admin → Settings → Outgoing email. Choose **Platform (default)** or **Own mail
server**. Optional phase 2, if OD-8 supports it: **Our sender, your domain**,
where the customer adds the provider's DKIM records and we send as
support@acme.com through the platform provider. For most customers this is the
easiest option with the best deliverability.

**Own mail server:**

- Fields: host, port (465, 587, 25 or 2525 only), security (implicit TLS or
  STARTTLS required; no plaintext), username, password, From address.
- Encrypt the password with the existing `encryptSecret(..., "smtp:<tenantId>")`.
  Never return it to the UI (show "set" or "not set"), never log it, and never
  include it in tenant exports.
- **Microsoft 365:** Microsoft is retiring basic-auth SMTP for Exchange Online,
  so a username and password will stop working. Provide a "Connect Microsoft
  365" option using OAuth2 (Entra app consent, nodemailer `XOAUTH2`). Store the
  refresh token encrypted, refresh it automatically, and flag Problem when
  consent is revoked.
- **Google Workspace:** SMTP relay or an app password through the generic form
  (document it). OAuth can come later.
- **SSRF protection (security-critical, required):** the tenant supplies the
  host, so:
  - resolve it ourselves;
  - refuse loopback, private (RFC 1918), link-local, CGNAT, multicast, IPv6
    ULA/link-local, and our own service addresses (db, storage, scanner,
    mailpit);
  - connect to the vetted IP, with the original hostname as the TLS
    `servername`, so DNS rebinding cannot swap the target;
  - re-vet on every connection.

  Tests cover `127.0.0.1`, `10.x`, `169.254.169.254`, `[::1]`, a hostname that
  resolves to a private IP, and the Docker service names.

- **"Send test email"** sends to the admin. Save the settings only after a test
  succeeds (or mark them unverified). Show the server's error reply in plain
  words, for example "authentication failed" or "TLS required", without
  credentials.
- **Failures:**
  - After 5 consecutive authentication or connection failures, mark the
    connection Problem.
  - Email the tenant admins through the platform sender, from the platform
    address, never spoofing their domain.
  - Switch that tenant's mail to the platform sender (EM-02) until fixed, so
    notifications keep flowing. Audit the switch.
- Transport cache per tenant, keyed by tenant and settings revision. Close idle
  connections. Apply per-tenant send budgets.
- Lifecycle: `read_only` sends admin-only mail through the platform sender.
  Deletion removes the credentials.
- Operator console shows the mode and status only, never host credentials.
- **Tests:**
  - encrypted at rest and never in API responses or exports;
  - an SSRF matrix refused;
  - plaintext refused;
  - the test-email path;
  - fallback after failures;
  - another tenant's settings are never used (negative test);
  - notification From and Reply-To are correct per mode.

---

## LR — What a paying customer must be given (launch readiness)

Owner direction (24 November 2026): the product is still in testing. **Legal
documents, ABN/GST/Stripe Tax setup and service commitments are deferred until
the owner decides to launch.** Do not draft legal text or configure live tax.
Keep the existing placeholder pages and checkbox. The "In the product" and
"Operations" items below can be built during testing.

Implemented features are marked ✓. Everything else is to build or to supply.

**In the product**

- ✓ Signup, trial, billing, view-only, deletion, MFA, operator console.
- First-run checklist on the admin home page, with each item linking to its
  guide:
  1. Invite your team (single invites, plus a CSV import if one does not exist).
  2. Review departments and categories.
  3. Set business hours and holidays.
  4. Set up email: forwarding (EM-01) and optional own sender (EM-03).
  5. Optional web address (CD-01).
  6. Branding.
- Branding: logo upload (scanned, size-limited image, shown in the app and
  emails) in addition to the existing brand name and colour.
- Admin help pages, plus a "Contact Astrama support" link. Run that support
  desk on Astrama itself, as its own tenant.

**Billing (Stripe)**

- ✓ Checkout, customer portal, dunning, cancellation.
- Turn on Stripe Tax, show the ABN on invoices, and have tax invoices emailed
  automatically. These are Stripe dashboard settings plus a note in
  `docs/production-deployment.md`.
- Seat changes: when an admin invites beyond the seat limit, offer "Add seats",
  which updates the subscription quantity through the portal or the API with
  proration. This is needed if prices are per seat (OD-3).
- Feature flags on billing plans (`customDomain`, `ownEmail`) so these features
  can be included or charged as add-ons per customer (**OD-9**).

**Trust and legal (owner supplies text; OD-6)**

- Terms, privacy policy, data processing agreement.
- Sub-processor list: hosting provider, Stripe, email provider.
- Data location statement (OD-1 region).
- Security page: MFA, encryption, tenant isolation, backups, how to report a
  vulnerability (`security.txt`).
- Service commitments: uptime target, backup frequency and restore time,
  support hours and response times.

**Operations**

- ✓ Status page (Uptime Kuma), backups, tenant-tagged alerts.
- Clean-host install, restore and upgrade drill on the real server.
- Real alert delivery to the owner's phone or email.
- A written incident and data-breach procedure (the Australian Notifiable Data
  Breaches scheme).

## Open-source choices (reviewed 25 November 2026)

npm licences were checked on the registry and all fit rule 10. Licence-check
again when adding.

| Need                                           | Use                                                                                                                                                                                 | Licence             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| EM-01 receive mail **without a paid provider** | Small `mail-intake` service: `smtp-server` (receive) + `mailparser` (MIME) + `mailauth` (SPF/DKIM/DMARC/ARC results) → the existing intake as a new adapter, with no webhook needed | MIT-0 / MIT / MIT   |
| Spam filtering for inbound (later, if needed)  | rspamd as a separate container                                                                                                                                                      | Apache-2.0 (verify) |
| Quoted-reply removal                           | `email-reply-parser`, replacing the hand-written regex                                                                                                                              | MIT                 |
| EM-03 "Connect Microsoft 365"                  | `@azure/msal-node` + nodemailer `XOAUTH2`                                                                                                                                           | MIT                 |
| Mailbox connection (later)                     | `imapflow`                                                                                                                                                                          | MIT                 |
| Sending, and DKIM signing                      | `nodemailer` (already used; has built-in DKIM signing)                                                                                                                              | MIT-0               |
| Self-hosted sending server (optional, later)   | Postal (open-source Mailgun-style service) or mox                                                                                                                                   | MIT (verify)        |
| Admin help pages (LR)                          | VitePress                                                                                                                                                                           | MIT                 |

Not allowed without owner approval (rule 10): Stalwart (AGPL-3.0) and Maddy
(GPL-3.0).

**EM-01 now defaults to the self-hosted `mail-intake` service.** Details:

- Its own container listens on port 25. Add an MX record for `in.astrama.com`.
  Accept only recipients that `resolve_inbound_address` knows, and refuse all
  others during the SMTP conversation, so we never become an open relay.
- It enforces a message size limit and per-sender connection and rate limits.
- The SPF/DKIM/DMARC results from `mailauth` replace the provider-supplied
  `authResults`.
- It writes through the existing intake path: dedupe, scanning, routing.
- No database credentials beyond the existing runtime role. It holds no
  tenant secrets.
- Tests use real SMTP from nodemailer in CI to the container: unknown recipient
  refused, an oversize message refused, a DKIM-signed fixture passes, a spoofed
  From fails DMARC → unverified triage.

**Sending stays on a relay at first.** Sending from a brand-new server IP
usually lands in junk at Microsoft 365 and Gmail. Most cloud hosts also block
outgoing port 25. Start with a low-cost relay through the existing nodemailer
SMTP settings. Amazon SES costs about US$0.10 per 1,000 emails, roughly US$6 a
month for a 100-user customer. Move to self-hosted Postal later only if volume
justifies the reputation work: a dedicated IP, reverse DNS, warm-up and
blocklist monitoring.

## MS-01 — Mail settings in the operator console and organisation settings (owner direction, 25 November)

**Owner direction:** testing runs **entirely on open source**. When the owner
is happy, switching to a paid service is a settings change in the UI, not a
code change or redeploy. Both our operator console and each organisation's
settings page get a guided mail setup.

### Open-source testing stack (compose profile `mail-oss`)

- **Sending:** mox (MIT, single Go binary; does DKIM signing, SPF, DMARC and
  MTA-STS itself). The app submits to it over authenticated SMTP on port 587
  with STARTTLS. Pin the image by digest.
- **Receiving:** the `mail-intake` service (EM-01: `smtp-server` + `mailparser`
  - `mailauth`).
- Mailpit stays for CI and local tests.
- Nothing else is added. mox's own inbound and IMAP are not used, because
  intake goes through `mail-intake`.

### Platform mail settings — operator console (owner role only)

- Move outbound mail config from env vars (`SMTP_HOST` and the rest) to a
  `platform_mail_settings` row. Keep the env vars as bootstrap fallback and for
  single-company mode.
- Page Operator → Platform email → **Sending**:
  - Provider preset buttons fill host, port and security for **Self-hosted
    (mox)**, **Amazon SES**, **Postmark**, **Mailgun** and **Other SMTP**. All
    use the same generic SMTP code path, so there are no per-provider SDKs.
  - Fields: host, port, security (TLS/STARTTLS only), username, password
    (write-only, encrypted with `encryptSecret(..., "platform-smtp")`), From
    domain, From address.
  - **DNS checklist** for the From domain: SPF, DKIM, DMARC, plus MX for the
    inbound domain. Show the record values to copy and a live
    ✓/✗ check (`node:dns`).
  - **Send test email** to the operator. A new profile can be activated only
    after its test passes.
  - **Activate** keeps the previous profile, with one-click **Roll back**.
  - Re-prompt for MFA on activate and rollback. Write an operator audit row
    with a reason.
- Page **Receiving**: MX check, last message received, queue depth, rejected
  count, and a "Send test to intake" button.
- Workers pick up the active profile without restart, through a transport cache
  keyed by settings revision.
- Health card: sends in the last 24 hours, failures, bounce rate, and a
  junk-risk warning when the bounce rate is above 5%.

### Organisation mail settings — tenant admin (Settings → Email)

One page with two cards, each with a step-by-step guide, a test button and a
status (Not set up, Pending, Working or Problem).

1. **Receive email as tickets.**
   - Shows the organisation's address (`acme@in.astrama.com`) and department
     addresses, each with a copy button.
   - Forwarding guides with screenshots for **Microsoft 365**, **Google
     Workspace** and **Other**.
   - "Check now" waits for a test email.
2. **Send email from your address.** Choose **Astrama default** (works
   immediately), **Microsoft 365** (Connect button, OAuth), **Google
   Workspace** (preset plus app-password guide) or **Other mail server** (the
   generic form). Rules are as in EM-03:
   - SSRF guard;
   - write-only secrets;
   - save only after a test passes;
   - automatic fallback to Astrama default on repeated failure, with an admin
     notice.

The operator console shows each organisation's mail mode and status read-only,
with **Reset to Astrama default** (reason, audited). It never shows customer
credentials.

### Switching to paid later

1. Operator → Platform email → Sending → pick a preset (for example Amazon SES).
2. Enter the credentials.
3. Copy the DNS records and wait for the DNS checklist to go green.
4. Send a test email.
5. Activate.

Rollback to mox is one click. Customers' own-server settings are unaffected.

**Tests:**

- profile switch without restart;
- activation refused until the test passes;
- rollback;
- secrets never in responses, logs or exports;
- the operator `support` role cannot view or change platform mail;
- tenant admin negative tests (cannot see other tenants' settings or the
  platform settings);
- a mox send in the `mail-oss` profile reaches `mail-intake` end to end.

## Owner decisions

- **OD-1 (partly answered):** the product domain appears to be `astrama.com`.
  Confirm it is owned and choose the hosting region.
- **OD-8 (narrowed 25 November):** receiving is self-hosted open source (see
  above). Testing sends through self-hosted mox (MS-01). The owner chooses a
  paid sending relay only at launch, in the operator console, without code
  changes.
- **OD-9:** is own email (EM-03) included in every plan or a paid add-on?
  (The custom domain is deferred; see the owner direction above.)

## Order

Step 0 → BR-01 → EM-02 → EM-01 (`mail-intake`) → MS-01 (mox profile and both
settings pages) → EM-03 → LR "In the product" items. CD-01 and
the legal/tax items are deferred. Each step is one
commit with tests, pushed only after CI and gitleaks are green.
