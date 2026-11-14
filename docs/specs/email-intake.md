# Email intake design

Status: implementation required. This specification records the approved CX-04
boundary; it does not claim that inbound email is implemented.

## Scope

Build inbound email behind an `InboundMailAdapter`. The first adapter is a
signed local test webhook used with Mailpit and a development command that
submits `.eml` files. Do not configure a real mailbox, provider, DNS, or
production credentials until the production mailbox is selected.

The adapter produces a normalized message containing tenant-resolved
recipient, provider message ID, threading headers, sender, recipients, subject,
plain text, sanitized HTML, attachments, and provider authentication results.
Tenant resolution uses the configured recipient address only. Persist accepted
messages in a tenant-scoped inbox table with a unique `(tenant_id, message_id)`
key. Verify request HMAC before persistence, return success quickly, then
process asynchronously in the existing worker/outbox model.

## Routing and ticket behavior

Administrators map normalized inbound addresses to active department groups
with active members. A configured general address maps to Service Desk Triage.
Unknown or inactive destinations also route to triage and create an audited
routing exception. Triage tickets are incidents with Email channel, the
“Not sure / General help” category (or mapped default category), and the
Untriaged flag. Notify the triage queue owner immediately; CX-05 defines the
first-touch target.

Send a link-only acknowledgement with the ticket number and a portal link to
choose a category. Category selection reroutes and audits the ticket. A support
agent can correct a misroute with the existing reason-required transfer action.
Email-originated activities are always customer-visible. Email never grants
access to a ticket.

## Identity, trust, and threading

Store random per-ticket reply tokens only as hashes. Put the token address in
Reply-To; correlate first by token, then by `In-Reply-To` / `References` for
messages previously sent. A subject ticket tag is considered only when the
sender is already a ticket participant. Replies to Complete, Cancelled, or
Rejected tickets create a linked new ticket.

Require provider-reported DMARC, SPF, and DKIM pass for the company domain.
Authentication failures go to triage as unverified and must not notify the
claimed account. Unknown senders create no ticket by default; a tenant setting
may allow unverified triage. Never infer tenant or user identity from message
body text.

Drop `Auto-Submitted: auto-*`, bulk and auto-reply precedence, and messages
from our own sender or Message-IDs. Record bounces against delivery records.
Apply a database-backed per-sender rate limit (initial proposal: 20 messages
per hour). Keep duplicate Message-IDs idempotent.

## Content and attachments

Preserve the original body for audit, sanitize HTML with a server-side
allowlist, and render plain text by default. Collapse quoted history in the
display while retaining the original. Reuse the existing attachment scan and
size limits; quarantine infected files while retaining the inbound message.
Never attach internal notes or ticket content to outbound email. Outbound
notifications remain link-only and include Reply-To, Message-ID, and
References headers.

## Smoke environment and acceptance

Seed a fictional smoke organisation with addresses under the reserved
`smoke.example.test` domain. Use Mailpit and signed local webhook requests.
Cover department and triage routing, fallback exceptions, category selection,
duplicate delivery, token and header correlation, terminal-ticket replies,
loop prevention, sender authentication failures, unknown senders, rate limits,
attachment quarantine, and cross-tenant rejection using real PostgreSQL.

No production provider account, DNS record, or credential is part of this
build. Configure those only in the final production mailbox setup.
