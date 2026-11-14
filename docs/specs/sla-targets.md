# SLA targets design

Status: implemented. These are proposed defaults, not confirmed customer
policy; owner confirmation is still required before treating them as service
commitments.

## Targets

Configure first-response and resolution goals per tenant and priority. Proposed
defaults are P1 1 hour / 4 hours (24x7), P2 4 hours / 1 business day, P3 1 / 3
business days, P4 2 / 5 business days, and P5 5 / 20 business days. Propose a
triage first-touch goal of one business hour. The admin interface must label
all these values “proposed” until the owner confirms them. Each target selects
business-hours or 24x7 calendar behavior; business hours use the tenant
timezone, configured work schedule, and holidays. The initial business-hours
schedule is Monday through Friday, 09:00–17:00 in the tenant timezone.

## Clock rules

Snapshot the applicable targets and calendar revision on ticket creation and
priority change. A configuration update affects new tickets only. A priority
change requires a reason, records an audit event, and recalculates the
snapshot. First response is the first customer-visible agent message; automated
notifications and auto-replies do not count. Resolution time stops at
`Resolved`; reopening with “Still a problem” starts a new resolution interval.
Elapsed time includes `On Hold` and every other non-terminal state.

## Alerts and reporting

The worker sends a warning at 75 percent and a breach alert once per ticket and
target. Queue views show time to breach. Reports show the percentage met by
department and priority. Tests use a fixed clock and cover weekends, holidays,
tenant timezone/DST changes, hold, resolution, reopen, and duplicate worker
delivery.
