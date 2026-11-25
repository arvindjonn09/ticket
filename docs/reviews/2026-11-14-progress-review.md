# Progress review — 14 November 2026

Reviewer: Claude (read-only). Scope: commit `33f698e` on `feat/structure-formatting`
(CX-03, CX-04, CX-05, CX-07, CR-A to CR-D). Method: code reading plus the GitHub
CI result. Tests were not run locally. The plan §13 checklist was not traced item
by item.

Execute **PR-A first**: nothing else can be verified while CI is red.

## Status check

- CI run on `33f698e`: **failed** at "Wait for the app". Lint, typecheck, build and
  format passed; no tests ran. gitleaks job passed.
- The commit is pushed to `origin/feat/structure-formatting`. [task-status.md](../task-status.md)
  still says "No commit or push has been made" and "do not push until full CI and
  both gitleaks scans pass". Either the gate was skipped or the status file is
  stale. Update it to match reality.
- Repository is still **public** (owner action, CR-01).
- The fixes CR-A (SLA audience, priority recalculation from original start with
  a reason, dispatch cursor) and CR-B (shared/exclusive lock split) are present
  in code and look correct.

## Findings

### PR-01 — CI red: web container never starts (blocking)

`infra/Dockerfile` `web` target changed from nginx to Caddy. `infra/Caddyfile`
uses `{$APP_DOMAIN}` as the site address, but the local/CI `web` service in
[compose.yaml:56](../../compose.yaml#L56) sets no `APP_DOMAIN`, so nothing serves
port 4310. `infra/nginx.conf` is now unused (its CSP edit has no effect).

Fix: in `compose.yaml` `web`, add `environment: { APP_DOMAIN: ":80" }` (Caddy serves
plain HTTP on :80). Delete `infra/nginx.conf` and any references. Check:
`docker compose up --build -d web` then `curl -fsS localhost:4310/` and
`curl -fsS localhost:4310/api/health`, and confirm the CSP header is present.

### PR-02 — Agent email replies become customer-visible (High, rule 6)

`process()` in [inbound-mail.service.ts](../../apps/api/src/modules/inbound-mail/inbound-mail.service.ts)
(the correlated-reply branch, around line 481) always writes
`audience: "customer"`. `isParticipant` also accepts any agent in the owning
group. So an agent who replies by email to an internal notification (a work-note
notice, an SLA warning) publishes that reply to the employee.

Also, `correlatedTicket` finds the delivery by reply token or `In-Reply-To` but
does not check that the delivery's recipient is the sender.

Fix:

- Derive the audience from the delivery being replied to. A reply to an
  internal-audience delivery becomes an internal note.
- Require the delivery recipient to equal the sender. If they differ, fall
  through to normal new-ticket handling.
- When an agent's email reply is customer-visible, set `slaFirstRespondedAt` if
  it is unset. The SLA spec says the first customer-visible agent message counts.

Negative test: an agent replies to an SLA alert email; the employee ticket view
and the employee notifications contain nothing from that reply.

### PR-03 — Email intake has no integration tests (High, definition of done)

The 973-line module, including its unauthenticated webhook, has only the
adapter unit test. `apps/api/test` contains no inbound tests. Add a
real-PostgreSQL suite covering:

- tenant A address with tenant B's secret → 401;
- bad or expired signature → 401;
- duplicate `messageId` → single row;
- a known user's address that fails authentication → unverified triage ticket,
  not impersonation;
- loop and auto-reply mail ignored;
- the 21st message in an hour is dropped;
- token, `In-Reply-To` and `[INC0001]` subject correlation;
- a reply to a Complete ticket → new ticket with `duplicateOfId`;
- a scanner failure deletes uploaded objects;
- PR-02's negative test.

Name each test after the plan §13 checklist item.

### PR-04 — Unverified email tickets name the queue owner as the requester (Medium)

`createInboundTicket` sets `callerId` and `submittedById` to the triage
reporter (queue owner or substitute). That agent shows as the requester in lists
and reports, and receives the employee-side notifications for strangers' email.

Fix (smallest): seed one inactive-login system user per tenant, "Email intake",
and use it as `submittedById`/`callerId` for unverified mail. Show
`inboundSenderEmail` as the requester in the support view. Owner/product check:
confirm this matches D5.

### PR-05 — Sender verification is too strict for real mail (Medium)

`verified` requires SPF, DKIM **and** DMARC to pass. Forwarded or relayed mail,
which is common in Microsoft 365, fails SPF while DMARC still passes through
aligned DKIM. Genuine employees are then downgraded to unverified triage. Use
`dmarc === "pass"`, because DMARC already requires an aligned SPF or DKIM pass.
Unit test both cases.

### PR-06 — Outlook quoted history is not removed (Medium)

`collapseQuotedHistory` handles "On … wrote:" and "Original Message" but not
Outlook's `________________________________\r\nFrom: … Sent: …` block. The first
customer will mostly use Outlook, so the whole quoted thread lands in the
ticket. Add the Outlook separator (`\n_{10,}\s*\r?\nFrom:` and
`\nFrom: [^\n]+\r?\nSent: `) with fixture tests for Outlook desktop, Outlook web
and Gmail. If more formats appear, replace the regex with an MIT reply-parser
library after a licence check.

### PR-07 — Webhook signs a re-serialised payload, not the raw body (Medium)

`webhookSignature` HMACs `JSON.stringify(normalize(input))`, which applies
trimming, lowercasing, Zod defaults and key order. No provider or relay can
reproduce that, so the first real adapter will fail.

Fix: HMAC `${timestamp}.${rawBody}` over the exact request bytes (Fastify raw body
for this route only), then parse. Do this before the real provider adapter.

### PR-08 — 8 MB body limit applies to every route (Medium)

`main.ts` raised Fastify's `bodyLimit` from 150 KB to 8 MB globally, including
unauthenticated login. Restore the 150 KB default and set 8 MB only on
`POST /inbound-mail/webhook` with a per-route `bodyLimit`. Check that a 200 KB
JSON body to `/auth/login` gets 413.

### PR-09 — Inbound failures are swallowed without a log (Medium, rule 11)

`process()` ends with a bare `catch {}`. A message can fail 8 times and become
`ignored` with no clue why. Log a structured error that includes the error name
or code, `tenantId`, inbound row id and attempt number. Do not log subject,
body, sender or attachment data.

### PR-10 — Webhook responses reveal which addresses exist (Low)

An unknown address returns 202. A known address with no secret returns 401
"Webhook is not configured", and a bad signature returns 401. Return the same
401 for any unsigned or invalid request, including unknown addresses. Keep 202
only for valid, signed requests.

### PR-11 — Rate-limited mail leaves no trace (Low)

Over-limit messages return `accepted` and are not stored, so an admin cannot see
why an email "never arrived". Store a row with status `ignored` and reason
`rate_limited`, without the body.

### PR-12 — Triage at the same priority keeps the triage SLA (Low)

In `manage()` ([tickets.service.ts](../../apps/api/src/modules/tickets/tickets.service.ts),
triage action), the snapshot is recomputed only if
`input.priority !== ticket.priority`. A ticket triaged at the default priority
keeps its 1-business-hour triage first-response target instead of the priority
target. Recompute on the untriaged → triaged transition as well.

### PR-13 — Service requests hard-code P4 (Low, rule 9 — check plan first)

[requests.service.ts:278](../../apps/api/src/modules/requests/requests.service.ts#L278)
and line 295 use the literal `"P4"`. If plan §5 makes P4 the fixed default for
service requests, leave it and add a comment. Otherwise read it from tenant
settings like `defaultPriority`. Do not guess: raise it if the plan is silent.

### PR-14 — Email reply to a Resolved ticket (Low, parity check)

`terminalMailStates` excludes `Resolved`, so an email reply adds a message and
the ticket stays Resolved. Confirm this matches the portal's behaviour for a
customer message on a Resolved ticket (reopen or "Still a problem" prompt) and
make email intake do the same.

## Still open from earlier packets

- CR-D: 4 failing delivery integration tests (recorded in task-status).
- CR-E (otplib, luxon, restic) and CR-F (dependency injection, support page
  split) are not started.
- CX-04: no real provider adapter yet. Smoke addresses only until production (D2).
- CX-07: clean-host install, restore drill and alert delivery evidence are
  outstanding.
- The ignored local `.env` gitleaks finding is unclassified. If it is a real
  credential, rotate it.
- Owner decisions still open: are Security tickets restricted to the Security
  group, and are the proposed SLA numbers approved.

## Packets

- **PR-A (now):** PR-01. Push and get CI green, including the full test step.
  Then fix the CR-D failures and update task-status to match git.
- **PR-B:** PR-02, PR-03, PR-05, PR-06, PR-09. Tests first: PR-03's suite should
  fail on PR-02, PR-05 and PR-06 before the fixes.
- **PR-C:** PR-07, PR-08, PR-10, PR-11.
- **PR-D:** PR-04 (after owner/product check), PR-12, PR-13, PR-14.
- Then continue CR-E and CR-F.
