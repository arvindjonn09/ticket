# SaaS packets review — 17 November 2026

Reviewer: Claude (read-only). Scope: `21de947..bbb50ce` (SA-01 to SA-03) plus the
status of the uncommitted SA-04 work. Method: code reading and the GitHub CI
result. Tests were not run locally, and Stripe was not exercised in live or
test mode.

## Status

| Packet                                            | State                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| SA-01 subdomains                                  | Pushed, CI green. Good.                                               |
| SA-02 lifecycle, trial, read-only, seats, starter | Pushed, CI green. Good.                                               |
| SA-03 signup, Stripe, ALTCHA, provisioning        | Pushed, CI green. Fix BL-01 to BL-04 before live payments.            |
| SA-04 public website                              | Uncommitted. The full visitor-to-first-ticket E2E journey is missing. |
| SA-05 operator console                            | Not started.                                                          |
| SA-06 hosted production                           | Not started.                                                          |

Repository is still public (owner action).

## What is right (keep)

- Host resolution: strict slug regex, reserved names, rejection of
  comma/userinfo hosts, an unknown host treated as unknown. Login is bound to the
  host tenant, and a session from another tenant's host is denied.
- Read-only status is enforced once in `SessionGuard` for every non-GET request.
  Only billing, MFA and logout are exempt.
- Workers (SLA, automation, inbound) only select `trial`/`active` tenants.
- Tenant status changes go to an append-only audit table protected by a trigger.
- Stripe webhook: raw-body signature, event-id dedupe inside a SECURITY
  DEFINER function, tenant id taken from our own signed metadata.
  `invoice.payment_failed` only acts after the final retry
  (`next_payment_attempt` null), which matches OD-4.

## Findings

### BL-01 — Out-of-order Stripe events can reactivate or wrongly lock a tenant (High)

Stripe does not deliver events in order, and the deduplication is by event id
only. An old `customer.subscription.updated` (status `active`) that arrives after
`customer.subscription.deleted` sets the tenant back to `active`. The reverse
order locks out a paying customer.

Fix: when processing any subscription, invoice or checkout event, retrieve the
**current** subscription from Stripe (`stripe.subscriptions.retrieve`) and derive
the transition from its live status, not from the event payload. Keep event-id
dedupe.

Test: deliver `deleted` and then an older `updated(active)`; the tenant stays
read-only.

### BL-02 — Checkout completion activates before money arrives (Medium)

`checkout.session.completed` always maps to `activate`. With delayed payment
methods (for example BECS Direct Debit in Australia), `payment_status` is
`unpaid` at completion and can later fail.

Fix: activate only when `payment_status` is `paid` or `no_payment_required`.
Otherwise wait for `checkout.session.async_payment_succeeded` or the
subscription becoming `active`, which BL-01's live retrieve covers.

### BL-03 — Deleting a tenant at day 45 does not cancel its Stripe subscription (Medium)

The lifecycle deletion has no Stripe step. A `payment_failed` tenant's
subscription can remain `unpaid` or `past_due`, so Stripe keeps sending invoices
and dunning emails to a company whose data we deleted.

Fix: before deletion, cancel the subscription (`stripe.subscriptions.cancel`,
idempotent), and record the provider reference in the deletion audit. If Stripe
is unreachable, retry the job rather than delete with a live subscription.

Test with the test provider.

### BL-04 — Deactivating a plan breaks renewals for existing customers (Medium)

`apply_billing_event` raises `billing plan is unavailable` whenever the event's
plan is inactive. The exception rolls back the event row, the webhook returns
500, and Stripe retries for days. Meanwhile a paying customer's renewal never
applies. Plans are per customer (OD-3), so operators will retire plans.

Fix: only require `active` for a **new** checkout. For events about an existing
subscription, accept the plan id the tenant already has.

### SA-04 — finish and push

The public site work is uncommitted. Required before closing it:

- Add the specified Playwright journey: visitor → signup → ALTCHA → Mailpit
  verification → provisioning → invite → activate on the subdomain → raise the
  first incident → test checkout → active.
- Push only after full CI and gitleaks are green.

## Next

1. BL-01 to BL-04, with tests (one commit).
2. Finish SA-04, push, CI green.
3. SA-05 operator console, then SA-06.
