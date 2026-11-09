# Small Business Ticketing System — Product Plan

Source: `plan.md`  
Updated: 9 November 2026  
Status: Requirements and multidisciplinary design reviewed; proposed architecture and business policies are identified below. Technology stack, sign-in approach, and commercial-product direction decided (section 21). Proposed defaults for remaining gaps are in section 22. Application implementation has not started.

## 1. Objective

Build a simple ticketing system for reporting incidents, requesting services, approving requests, and managing support work. Provide clear experiences for employees, approvers, and the staff working on tickets.

Plan the initial setup for one company with approximately **100 users**. Automatically route incidents and service requests to the responsible department based on the selected category. The ticketing administrator controls categories and their department assignments through settings.

**Commercial goal (agreed):** after the first company runs it in production, the system will be sold to other businesses. Build it as a product from the start: customer-company data isolation, configurable branding and settings, no customer-specific code, and commercially licensable dependencies. See section 21.

Requirements below come from `plan.md` and subsequent agreed updates. Recommendations and proposed rules are identified separately so that suggested defaults are not mistaken for agreed business policy.

## 2. Ticket Types and Numbering

| Type | Purpose | Numbering |
| --- | --- | --- |
| Incident | Restore something that previously worked and is now broken or degraded. | `INC0001`, `INC0002`, and onward. |
| Service request | Request a new item, software, access, or standard service. | `SR0001`, `SR0002`, and onward. |

Generate numbers automatically using independent sequences. Use at least four numeric digits, allowing growth beyond `9999`. Numbers must be unique, immutable, and never reused. Concurrent submissions must not produce duplicates; sequence gaps are acceptable.

## 3. Roles and Permissions

| Role | Main capabilities |
| --- | --- |
| Employee / requester | Submit tickets, track permitted tickets, send customer messages, and attach files. |
| Approver | Review assigned approvals, inspect relevant request details, and approve or reject. |
| Support agent | Triage, claim tickets in their own groups, investigate, communicate, add internal notes, transfer misrouted tickets with a reason, and record resolution or fulfilment. |
| Queue lead (proposed) | A support agent who is the department's queue owner or substitute. Can additionally assign tickets to other group members, reassign claimed work, and handle escalations for that group. This is the "authorized lead" in section 6. |
| Ticketing administrator | Manage users, departments, assignment groups, categories/subcategories, category-to-department mappings, request items, approval rules, and settings for their company. |
| Platform operator (proposed, for commercial use) | Vendor-side role that provisions customer companies (tenants) and supports operations. Has no access to customer ticket contents by default. |

Recommended access rules:

- Employees see their own submissions and requests made for them, subject to sensitive-ticket restrictions.
- Approvers see information needed for their assigned decisions; approval responsibility alone does not grant access to internal work notes.
- Support access follows group and role permissions. Restrict sensitive Security tickets where needed.
- A user may have multiple roles. Enforce permissions on every ticket, profile, search result, action, and attachment.
- Configuration administration does not automatically grant access to confidential ticket contents. Keep ticket sensitivity independent of its current category and department so transfers do not broaden access accidentally.

## 4. Incident Fields

| Field | Requirement |
| --- | --- |
| Number | Automatically generated `INC` identifier; read-only. |
| Caller | User reporting or experiencing the issue. Record the submitting user separately when created on someone's behalf. |
| Channel | Email, Phone, Self Service, Walk In. |
| Category | Administrator-managed options; initially Hardware, Software, Application, Networking, Server, Security. Determines the responsible department. |
| Subcategory | Options depend on the category selected. |
| Short description | Required summary of the issue. |
| Description | Recommended additional field for symptoms and supporting details. |
| Attachments | Broad format support, subject to the attachment policy in section 10. |
| Priority | P1 through P5. |
| Severity | S1 through S4. |
| State | Open, In Progress, On Hold, Resolved, Complete, Cancelled. |
| Assignment group | Automatically selected department queue based on category; authorized staff can transfer with a reason. |
| Assigned to | Responsible agent; must belong to the selected assignment group. |
| Work notes | Internal support notes. |
| Resolution | Internal record of the fix, reusable as internal knowledge. |
| Customer message | Communication visible to the customer. |
| Audit details | Recommended: created at/by, updated at/by, and material change history. |

### Proposed incident workflow

`Open → In Progress → Resolved → Complete`

- **Open:** logged and awaiting triage or assignment.
- **In Progress:** support is investigating or restoring service.
- **On Hold:** waiting on a customer, supplier, or dependency. Require a hold reason and allow return to the previous active state.
- **Resolved:** service is believed to be restored. Require an internal resolution and a customer-facing summary.
- **Complete:** customer confirms the fix, or an agreed automatic closure policy applies.
- **Cancelled:** withdrawn, duplicate, or created in error. Require a reason and link the original ticket for duplicates.
- Allow a resolved incident to return to In Progress when the issue persists. Confirm the policy for reopening completed tickets.

Retain “Complete” as the final closed state from the source plan; avoid adding a separate “Closed” state with the same meaning.

### Proposed priority and severity definitions

Priority determines work order and response expectations. Severity describes the scale of disruption. Agents should consider business impact and urgency when setting priority; severity alone does not determine it.

| Priority | Proposed meaning |
| --- | --- |
| P1 — Critical | Immediate attention for a critical business disruption. |
| P2 — High | Significant disruption requiring prompt attention. |
| P3 — Medium | Normal operational issue requiring scheduled support. |
| P4 — Low | Limited disruption with a usable workaround. |
| P5 — Planning | Lowest urgency; work can be scheduled with the requester. |

| Severity | Proposed meaning |
| --- | --- |
| S1 — Critical | Critical service unavailable with broad business impact. |
| S2 — Major | Major loss of functionality or multiple users affected. |
| S3 — Moderate | Limited disruption affecting a small group or individual. |
| S4 — Minor | Minor degradation with little operational impact. |

Record reasons for priority changes. Agree support hours, response targets, escalation ownership, and SLA pause rules before enabling timers. These proposed labels do not establish service commitments.

## 5. Service Request Fields

| Field | Requirement |
| --- | --- |
| Number | Automatically generated `SR` identifier; read-only. |
| Requested by | User submitting the request. |
| Requested for | User receiving the item or service. |
| Channel | Email, Phone, Self Service, Walk In (same as incidents). |
| Short description | Required summary. |
| Description | Recommended details of what is needed. |
| State | Open, Pending Approval, In Progress, On Hold, Rejected, Complete, Cancelled. |
| Request item | One catalog item per request for the initial release (proposed): software, application, access, equipment, or service. |
| Category | Administrator-managed options, including Application and Software. Determines the responsible department; administrators control applicability to incidents and requests. |
| Subcategory | Options depend on the selected category. |
| Approval manager | Manager responsible for approval. |
| Additional approval | VP approval for designated software or requests meeting a configured cost rule. |
| Priority | P1 through P5; support validates urgency. |
| Assignment group | Automatically selected department queue based on category. Approval requirements still apply before fulfilment. |
| Assigned to | Agent within the selected group. |
| Cost details | Recommended: quantity, unit price, total, currency, and recurring billing period when relevant. |
| Justification | Recommended business reason for requests requiring approval. |
| Messages and attachments | Recommended: reuse incident communication and visibility controls. |
| Audit details | Recommended creation, changes, approval decisions, and fulfilment history. |

### Proposed request workflow and approval rules

`Open → Pending Approval (when required) → In Progress → Complete`

Additional states: On Hold, Rejected, and Cancelled.

- Requests without an approval requirement can proceed directly to fulfilment.
- Proposed order: manager approval first, then VP approval when the item or price rule requires both.
- Block fulfilment until every required approval succeeds.
- Rejection stops fulfilment and requires a reason visible to the requester.
- Missing approvers go to an administrator for correction; never silently approve a request.
- Record approver identity, decision, timestamp, and comment. Prevent duplicate decisions and decisions against an outdated request.
- Prevent self-approval and configure an alternate approver where necessary.
- Re-evaluate approvals when the item, cost, or requested-for user changes. Material changes invalidate affected previous approvals.
- Recommended: derive the approval manager from the **Requested for** user's manager record. Authorized corrections require an audit reason; requesters cannot select an arbitrary approver.
- Cancellation invalidates pending approvals and stops fulfilment. Later approval links must reject decisions on cancelled or superseded requests.

The software list, cost threshold, currency, recurring-cost basis, and replacement approvers remain business decisions.

## 6. Category and Assignment Rules

### Administrator-managed departments and categories

- Only the ticketing administrator can add, rename, activate, remove/archive, or change the routing of categories and subcategories.
- Each active category must map to one active responsible department and its assignment group/queue. Multiple categories may route to the same department.
- For the initial 100-user setup, use one assignment group per responsible department. A department is the business owner; its assignment group contains the support agents who handle its tickets. The requester's own department does not determine routing.
- Administrators manage department/group membership and choose whether a category is available for incidents, service requests, or both.
- Each subcategory belongs to a category and inherits its department routing for the initial release. Changing category clears an incompatible subcategory; changing group clears an incompatible assignee.
- Removing a category used on tickets archives it: hide it from new submissions while preserving existing ticket history. Permanently delete only categories with no ticket, configuration-history, or other retained references. Prevent removal of an active routing destination until affected categories have a replacement.
- Record who changed a category or mapping, when, and what changed. Configuration changes apply to future routing events; they do not silently move existing tickets.
- Include a **Not sure / General help** category mapped to triage. Self-service requires an active category, including this option. Unknown classifications from agent/import channels use triage with a recorded routing exception; a stale category selection prompts correction without losing the form.
- Each department has a named queue owner and substitute responsible for unclaimed tickets, holds, and escalation. Automatic routing establishes ownership; an agent claiming a ticket establishes individual responsibility.

### Automatic department routing

1. On ticket submission, validate the category and look up its current department mapping.
2. Set the department and assignment group automatically, regardless of whether the ticket was entered through self-service or by an agent. Future email intake uses the same rules.
3. Place the ticket in that department's queue and notify the responsible team. The employee does not need to choose a department or agent.
4. Leave **Assigned to** empty until a member of that group claims the ticket or an authorized lead assigns it. Automatic department distribution does not require individual-agent load balancing.
5. For service requests, route ownership immediately but retain Pending Approval where needed; routing must not bypass approval.
6. When an authorized agent corrects the category on an active ticket, reapply routing and log the transfer. Clear an assignee who is not in the new group and notify the destination team. Completed and cancelled tickets retain their recorded ownership unless explicitly reopened or transferred.
7. If a ticket has no usable category or the destination is missing, inactive, or has no active support members, send it to a restricted **Service Desk Triage** queue and alert the administrator. Never lose or silently discard a ticket. For sensitive categories, preserve restricted access in triage.
8. Allow authorized support staff to transfer a misrouted ticket with a reason. Keep the transfer until a later explicit category change or transfer; a normal save must not overwrite it.

Do not allow a category to be activated without a valid routing destination. Revalidate the destination on submission so a configuration change during form entry cannot produce an orphaned ticket.

Example initial mappings and subcategories, to be confirmed by the company. These are configurable examples, not required separate departments:

| Category | Example subcategories | Responsible department / queue |
| --- | --- | --- |
| Hardware | Laptop, Desktop, Monitor, Printer | IT Support |
| Software | Installation, Update, Licensing | IT Support |
| Application | Login, Error, Performance | Application Support |
| Networking | Wi-Fi, VPN, Internet | IT Infrastructure |
| Server | Availability, Storage, Backup | IT Infrastructure |
| Security | Suspicious Email, Account Compromise, Malware | Security Support (restricted) |

For a small support team, IT Support may handle several or all of these categories. The administrator can later add categories such as Payroll or Facilities and map them to the relevant departments without changing the ticket forms or requiring a software release.

## 7. UI and UX

### Employee portal

- Home page with **Report an issue**, **Request a service**, and **My tickets**.
- Short forms that reveal questions only when relevant. Pre-fill the signed-in user and Self Service channel.
- Describe categories in plain language with examples and offer Not sure / General help. Employees provide the issue/request, affected user, and relevant details; agents complete operational priority, severity, and assignment fields.
- Ticket list showing number, summary, status, and last update.
- Ticket detail showing progress, customer messages, permitted attachments, and the responsible team.
- Keep internal notes, internal resolution knowledge, and assignment controls in the staff view.

### Support workspace

- Queues: Service Desk Triage, My Tickets, My Department / Group, Unassigned in My Group, On Hold, and Pending Approval.
- List columns: Number, Type, Short Description, Caller / Requested For, Priority, State, Group, Assigned To, Updated.
- Search by number, summary, or permitted user details; filter by type, state, priority, category, channel, group, and agent.
- Prominent ticket header with number, summary, status, and priority.
- Main details and activity area, with a side panel for classification, assignment, and clickable user information.
- Visibly distinct **Customer message** and **Internal work note** actions that identify the audience before posting.
- Accessible labels, keyboard navigation, mobile-friendly layouts, and text alongside status colors.

### Approver workspace

- “My approvals” queue showing requester, requested-for user, item, cost, justification, and waiting time.
- Request detail showing the approval sequence and previous decisions.
- Clear Approve and Reject actions, with a required rejection reason.
- Check the user's approval authority and current request version on every decision.

### Ticketing administrator workspace

- Department/group list with active status and support members.
- Category list with name, applicable ticket types, subcategories, destination department/group, and active status.
- Add, Edit, Map Department, and Remove/Archive actions, with validation before saving.
- Show the effect of removing a category or changing a mapping, including whether existing tickets will remain in their current queues.
- Provide a routing preview: select a category and see the department/group that would receive a new ticket.
- Show routing failures requiring attention in the Service Desk Triage queue.

## 8. User Profiles and History

User names should be clickable wherever they appear, subject to access permissions.

Show relevant name, email, contact details, department, manager, account status, created/updated timestamps, and permitted incident/request history. Distinguish tickets created by the user from requests created for them.

“Complete details” means all relevant details the viewer is authorized to access. Profiles and search must not expose another employee's private tickets.

## 9. Messages and Internal Knowledge

- Keep customer messages and internal notes distinct in storage, views, search, attachments, and notifications.
- Record author and timestamp for each activity entry.
- Store incident resolutions internally and allow authorized staff to search past fixes.
- Recommended later feature: turn a useful resolution into a reviewed knowledge article containing symptoms, fix, and source ticket link.
- Remove personal details and secrets before publishing knowledge. Keep articles internal unless a separate customer publishing feature is explicitly introduced.
- Maintain an audit history of material field changes, state transitions, assignments, and approval decisions that ordinary users cannot edit.

## 10. Attachment Policy

Source requirement: accept all kinds of file formats.

Recommended approach: broad format support through an administrator-managed policy, with validation, size limits, scanning, protected storage, and authorized downloads. These controls follow [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

- Confirm required formats and per-file/per-ticket size limits.
- Distinguish internal attachments from customer-visible attachments.
- Validate filenames and content; quarantine suspicious uploads.
- Serve potentially active content as downloads rather than inline previews. Agree how to handle files that cannot be scanned or safely processed.
- Clearly explain rejected uploads without losing the rest of the form.

Unrestricted formats remain an open requirement; this recommendation does not silently replace that requirement.

## 11. Recommended Small Business Setup

Start with one service desk for approximately 100 company users, a small number of actual support departments/groups, and shared user/category management. Use separate incident and request workflows with consistent navigation. Category-based department routing is a core launch requirement.

- Set up the initial users, their managers and home departments, and the smaller set of agents/approvers/admins. Do not assume all 100 users are support agents.
- Create the department queues and support memberships, configure the restricted triage fallback, then map and activate categories before opening submissions.
- Launch self-service and agent-entered tickets first. Agents can record Email, Phone, and Walk In channels immediately.
- Treat automatic email intake as a separate integration: correlate replies, prevent duplicate tickets, and prevent notification loops.
- Notify customers of creation, public messages, approval outcomes, and completion. Notify agents of assignments and approvers of pending decisions.
- Agree an escalation owner and operating hours for P1 incidents.
- Begin with a small request catalog with clear approval and assignment rules.
- Track ticket volume, backlog, age, response/resolution time, and approval waiting time. Define business-hour calculations before interpreting reports.
- Establish authentication, least-privilege access, backup/restore, and retention rules before production use.

These are proposed operating choices for this system, rather than a recommendation to purchase a particular platform.

## 12. Delivery Phases

| Phase | Deliverables | Completion check |
| --- | --- | --- |
| 1. Confirm rules | 100-user setup, roles, departments/groups, category mappings, workflows, priorities, approval rules, attachment policy. | Business decisions and initial routing destinations are documented. |
| 2. Core tickets | Access, profiles, numbering, forms, administrator category management, automatic department routing, triage fallback, queues, assignment, messages, attachments, audit history. | Both ticket types reach the correct department automatically; category changes require no software release. |
| 3. Approvals | Request items, costs, manager/VP routing, approval queue, rejection handling. | Fulfilment cannot bypass approvals; material changes invalidate stale decisions. |
| 4. Launch readiness | Notifications, internal resolution search, basic reporting, permissions, backup/restore checks. | End-to-end workflows and recovery checks pass. |
| 5. Later improvements | Automatic email intake, reviewed knowledge articles, agreed SLA timers, extra routing automation. | Each improvement has a demonstrated business need and acceptance criteria. |

Manual Email channel recording is part of the core; automatic mailbox integration is proposed for later. Confirm if automatic intake is needed at launch.

Phases 2 and 3 are development milestones, not independent production releases. Pilot the complete incident and approval workflows after phase 4, resolve findings, train users, and then roll out to the company.

## 13. Acceptance Checklist

- [ ] Concurrent submissions produce unique `INC` and `SR` numbers with independent sequences.
- [ ] Both forms contain required fields and enforce relevant validation.
- [ ] Subcategories follow category selection; assignees follow group selection.
- [ ] An administrator can add, rename, map, archive, and remove unused categories through settings; other roles cannot change routing configuration.
- [ ] New incidents and service requests automatically reach the mapped department/group for each active category.
- [ ] A new category and mapping work without a software release; archived categories disappear from new forms but remain on historical tickets.
- [ ] Category corrections reroute active tickets, clear incompatible assignees, notify the destination, and record the change.
- [ ] Mapping changes do not silently move existing tickets, and ordinary saves preserve explicit transfers.
- [ ] Missing/invalid routing reaches restricted triage with an administrator alert, without exposing sensitive tickets.
- [ ] Service request routing does not bypass pending approvals.
- [ ] The setup supports approximately 100 user accounts with the intended employee, approver, agent, and administrator access.
- [ ] State transitions enforce hold, cancellation, resolution, and reopening rules.
- [ ] Resolution requires internal details and a customer-facing summary.
- [ ] Ordinary and VP-required requests follow the correct approval path.
- [ ] Rejected, missing-approver, self-approval, and materially changed requests cannot bypass controls.
- [ ] Employees, approvers, and agents see only authorized records and attachments.
- [ ] Internal notes and resolutions never appear in customer views or notifications.
- [ ] User profiles show permitted ticket history and created/updated details.
- [ ] Attachments follow the agreed format, size, scanning, and visibility policy.
- [ ] Notifications reach the correct audience without leaking internal content.
- [ ] Audit history captures material changes and approval decisions.
- [ ] Backup restoration is verified before launch.
- [ ] Concurrent agent claims and edits reject conflicts instead of silently overwriting work.
- [ ] Duplicate submission retries return the existing result rather than creating duplicate tickets.
- [ ] Cancellation, stale approvals, category archival during submission, and support-member removal are exercised.
- [ ] Sensitive ticket restrictions survive transfers, recategorization, triage, search, exports, and notifications.
- [ ] Notification failure does not lose tickets; retries do not repeat business actions.
- [ ] A pilot covers employee submission, department claiming, both approval paths, resolution, and recovery.

## 14. Business Decisions Still Needed

1. The initial scope is approximately 100 company users; will external customers need access later?
2. Which actual departments/groups will handle tickets, who belongs to them, and who owns the restricted triage queue?
3. What are the initial category/subcategory lists, their department mappings, and request items? Administrators can maintain them after setup.
4. Which software requires VP approval, and what price threshold, currency, and recurring-cost basis apply?
5. Is manager-then-VP approval suitable, and who substitutes for unavailable approvers?
6. What support hours, response targets, priority/severity definitions, and escalation rules apply?
7. Does completion require customer confirmation or an automatic closure period? Can completed tickets reopen?
8. Which attachment formats and limits are needed, including executables and archives?
9. Is automatic email intake needed at launch, and which mailbox should it use?
10. ~~Which identity provider~~ (decided: built-in login, SSO later). Which hosting environment, backup schedule, and retention policy apply? Which country's data-protection law applies?
11. Who are the business sponsor, service owner, technical owner, and department queue owners/substitutes?
12. What are the budget ceiling, target launch date, and acceptable recovery targets? Is a custom build preferred after comparing configuration and ownership costs? (Commercial-sale intent now favours a custom build.)
13. Commercial model: hosted subscription (SaaS) for all customers, a separate install per customer, or both? Pricing per agent or per company? Product name and brand?
14. Is there one VP for the company or one per department? Who approves when the requester's manager is the VP?

## 15. Research References

These primary sources informed the recommendations. Proposed policies above still need to be adapted to the business.

- [Atlassian: Incident management process](https://www.atlassian.com/incident-management/itsm) — incident triage, restoration, and closure practices.
- [Atlassian: Incident fields](https://support.atlassian.com/jira-service-management-cloud/docs/default-fields-in-an-agents-view-of-an-incident/) — classification and priority context.
- [Atlassian: Request approvals](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/) — approval steps in request workflows.
- [Atlassian: Public and internal request comments](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/) — explicit separation of comment audiences.
- [OWASP: File upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — upload validation, storage, access controls, and limits.
- [OWASP: Authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — default denial and authorization on every request.
- [PostgreSQL: Database constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — primary keys, uniqueness, and referential integrity if PostgreSQL is selected.

## 16. Design Review by Perspective

The following is the consolidated recommendation from the specialist reviews, coordinated by the primary agent. It is a proposed implementation design, not evidence that an application has been built or load tested.

| Perspective | Design decision | Business benefit |
| --- | --- | --- |
| Systems engineer | One web application, relational database, private file storage, and a small retryable job runner. Central authorization and recoverable deployments. | A manageable operating footprint with reliable routing and recovery. |
| Data engineer | Stable identifiers, relational integrity, transactional writes, versioned approvals, explicit message audiences, and recorded state changes. | Trustworthy history, consistent approvals, and meaningful reporting. |
| Systems analyst | Two guided submission paths, clear state transitions, category-driven queues, accountable owners, and a complete workflow pilot. | Employees can get help without understanding internal department structures. |
| CEO / business sponsor | Fixed first-release scope, named operational owners, an ownership-cost assessment, and measurable service outcomes. | Predictable investment and demonstrable value for the company. |

## 17. Proposed Application Architecture

Use one deployable application with employee, support, approver, and administrator views. Keep tickets, routing, approvals, and reporting as modules within it. The implementation stack is decided in section 21; the repository currently contains planning documents only.

```text
Company users → Web application → Relational database
                       │                 │
                       │          Pending notification jobs
                       │                 ↓
                       │            Job runner → Email
                       ↓
              Private attachment storage

Company identity provider → Application sign-in
Database + attachments → Protected backup and restore
```

- **Database:** one relational database is the proposed source of truth. PostgreSQL is a candidate, subject to hosting and team constraints. Start with database queries for lists, search, and reports.
- **Routing:** use the administrator's category mapping as a direct lookup. No AI classifier or general-purpose rules engine is needed for the requested routing.
- **Consistency:** allocate the number and save the ticket, selected destination, routing/audit event, and pending notification together in one transaction. Deliver notifications after commit. Use a submission key to recognize retried creates.
- **Concurrency:** use revisions or conditional updates for edits, claims, category mappings, and approval decisions. Surface a conflict and reload current values instead of silently overwriting them.
- **Notifications:** a database-backed jobs table and scheduled runner are sufficient initially. Retry failures with a stable event/recipient identity, expose failed jobs to the operator, and avoid duplicate delivery where possible. Delivery retries must never repeat approval or ticket actions.
- **Attachments:** keep content in private storage and metadata in the database. Mark files pending until validation/scanning succeeds; remove abandoned uploads through a controlled cleanup process.
- **Identity:** prefer the company's existing identity provider and its MFA controls for privileged users. Confirm the provider before integration. Deactivate accounts without erasing authorship, revoke sessions, and reassign unresolved work and pending approvals.
- **Authorization:** central server-side policy checks cover record and field access, attachment downloads, search/counts, exports, and notification rendering. The proposed policy follows [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- **Operations:** separate development/test/production configuration, protect secrets, use TLS, apply versioned database migrations, and document deployment rollback. Monitor health, routing failures, failed jobs, storage capacity, and backup age without putting sensitive ticket contents into operational logs.
- **Recovery:** restore database and attachment content together and verify their consistency. A named technical owner runs and records recovery exercises.

Keep the first release free of microservices, a separate analytics warehouse, a dedicated search cluster, custom workflow builders, and individual-agent load balancing. Reconsider each only when a measured requirement justifies it.

## 18. Proposed Data Model and Integrity Rules

This is a logical model; final table names and migrations belong to implementation.

| Record | Core information |
| --- | --- |
| Tenant (customer company) | Stable ID, name, status, branding, timezone, locale, and plan/licence details. Every business record below carries a tenant reference. |
| User | Stable ID, tenant, identity subject, contact details, home department, manager, active status, and roles. |
| Credential and session | Password hash (Argon2id), MFA secret where enabled, failed-attempt counter/lockout, password-reset tokens (hashed, expiring), and revocable sessions. Replaced or supplemented by SSO later. |
| Department and membership | Department/queue, owner, substitute, active support members. For launch, the department's queue is its assignment group; avoid duplicate independently editable routing destinations. |
| Category / subcategory | Stable ID, label, active status, applicable ticket types, destination department, and parent category where applicable. |
| Ticket | Internal ID, type, sequence, submitting and affected users, category/subcategory, state, priority, incident severity, current destination/assignee, sensitivity, revision, and timestamps. |
| Catalog item | Stable ID, name, description, category, active status, default unit price/currency, billing period, and flags: requires manager approval, always requires VP approval. |
| Approval rule and approver mapping | Cost threshold, currency, recurring-cost basis, the VP (or VP per department) and alternate approvers, with effective dates and change history. |
| Tenant settings | Business hours, holidays, auto-close period, attachment limits/allowed types, notification templates, and number prefixes. |
| Request details | Item and approved cost snapshot, quantity, exact decimal price, currency, billing period, and justification. |
| Approval | Ticket/request revision, stage, resolved approver identity, pending/approved/rejected/superseded status, decision time, and comment. |
| Activity and audit | Author, timestamp, kind, customer/internal audience, messages, state/assignment changes, and routing decision with mapping revision or audit reference. |
| Attachment | Ticket/activity reference, storage key, uploader, audience, filename, size, detected type, and scan status. |
| Notification job | Event, recipient, delivery state, attempt count, next retry, and failure summary. |

Integrity rules:

1. Use stable internal IDs and foreign keys. Deactivate referenced users and categories rather than deleting history.
2. Allocate independent incident/request numbers through database sequences or transactionally locked counters; enforce uniqueness on type plus sequence. Never use the current maximum plus one.
3. Store the chosen destination on the ticket. Looking up today's category mapping must not rewrite historical ownership.
4. Enforce permitted states and required fields per ticket type. Validate active group membership when claiming or transferring work; handle removal of an assigned member through reassignment/triage.
5. Snapshot material request details and resolved approver identities. Directory or pricing changes do not rewrite past decisions. A material request revision supersedes affected approvals.
6. Require explicit customer/internal audiences. An attachment cannot be more visible than its parent activity. Restrict ticket content independently of its current routing category.
7. Use UTC timestamps and display them in the configured company timezone. Preserve transition events to distinguish hold time, first resolution, reopening, and final completion.
8. Audit records are append-only for ordinary users; do not claim they are tamper-proof against privileged database operators.
9. Set business-owned retention periods separately for tickets, attachments, audit records, and backups. Account deactivation, data anonymization, and backup expiry need explicit policies.

Use database uniqueness and referential constraints where appropriate; enforce cross-record workflow and authorization rules transactionally in application logic. [Reference: PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

## 19. Ownership, Cost, and Success Measures

| Accountable owner | Responsibility |
| --- | --- |
| Business sponsor | Scope, funding, value, and acceptance of business policies. |
| Service owner | Daily operation, support hours, escalation, training, and service reporting. |
| Department queue owner and substitute | Unclaimed work, holds, workload, and overdue approvals needing escalation. |
| Ticketing administrator | Categories, routing configuration, memberships, and catalog maintenance. |
| Technical owner | Delivery, patching, identity integration, monitoring, backups, and recovery. |

Before committing implementation spend, compare configuring an existing system with a custom build against the same acceptance scenarios. Include delivery/configuration, licenses if applicable, hosting, integration, support time, maintenance, backups, and training. This is a decision checkpoint, not a vendor or purchase recommendation; no costs or savings have been established.

Report service outcomes by department rather than ranking individuals:

- **Correct first routing:** proportion reaching the intended department without a transfer marked as misrouting; distinguish planned handoffs.
- **First human response:** first customer-visible agent response minus creation time; exclude automated acknowledgements.
- **Backlog and age:** nonterminal tickets by department/priority and agreed aging buckets.
- **Resolution and reopening:** distinguish first resolution from final completion; record reopening rate and show medians/upper percentiles rather than averages alone.
- **Approval wait:** time pending at each stage, keeping superseded approvals out of the current pending count.
- **Employee experience:** pilot submission success without assistance and a simple satisfaction measure after completion.

Agree numeric business targets after collecting a baseline. Do not infer ticket volume or simultaneous usage from the 100-account company size.

Proposed technical pilot targets, pending owner acceptance: 100 registered accounts, 20 concurrent active sessions, and 95% of list/detail requests below two seconds in a documented test environment. Proposed recovery starting point: at most 24 hours of data loss and restoration within four hours. These are targets to validate, not measured results or approved service commitments.

## 20. Orchestrated Delivery and Review

Use the primary agent as orchestrator with bounded specialist tasks. The reviews for this design used a systems engineering agent, a data engineering agent, and a combined systems analyst/CEO review agent. Agents advise and implement; human owners remain accountable for spending, operational policy, and production acceptance.

| Agent responsibility | Deliverable | Review gate |
| --- | --- | --- |
| Orchestrator | Integrated scope, task dependencies, acceptance scenarios, and final change review. | Resolve conflicting assumptions and keep every change traceable to a requirement. |
| Systems engineering | Application foundation, identity/authorization, deployment, job handling, and recovery. | Reliable writes, denied unauthorized access, failed-delivery recovery, and restore evidence. |
| Data engineering | Schema/migrations, integrity rules, approval snapshots, and reporting definitions. | Concurrent numbering/claiming, historical preservation, and stale-decision checks. |
| Systems analysis | Forms, state transitions, queue behavior, and end-to-end scenarios. | Employee, agent, administrator, and approver journeys pass the pilot. |
| Business / CEO review | Scope, ownership-cost comparison, priorities, and success criteria. | Sponsor accepts scope, owners, budget, and rollout conditions. |

Implementation order:

1. Resolve identity/hosting constraints and record initial departments, queue owners, approval thresholds, and attachment policy; choose the supported stack.
2. Deliver one working slice: signed-in employee submits an incident, category routes it, an authorized agent claims it, and the employee sees a public reply. Include persistence, audit, and permission checks from the start.
3. Add administrator category/mapping management, archived-category behavior, routing exceptions, conflict handling, and sensitive-ticket controls.
4. Add service request catalog and the full manager/VP approval workflow, including stale decisions, cancellation, and cost revisions.
5. Complete permitted attachments, notifications/retries, internal resolutions, user history, and basic reports.
6. Exercise the acceptance checklist, test recovery and the agreed pilot workload, run a small employee/agent/approver pilot, fix findings, and roll out to the full company.

During implementation, assign agents non-overlapping files or clearly bounded tasks. Keep schema decisions shared, integrate dependent changes in order, and require orchestrator review of access control, migrations, routing, and approval behavior before delivery. Do not introduce permanent application agents for deterministic category routing.

## 21. Product and Engineering Decisions

Decided 9 November 2026 unless marked *proposed*.

### Direction

- **Commercial product.** First deployment serves one company of about 100 users. Afterwards the product will be sold to other businesses, so every feature is built tenant-aware, configurable, and free of company-specific code.
- **Sign-in.** Built-in accounts at launch; SSO (OIDC/SAML, e.g. Microsoft Entra ID or Google) added later through a pluggable authentication adapter, without changing the rest of the application.
- **Hosting.** Not yet chosen. Develop and test with Docker Compose locally; keep the application container-based and cloud-neutral (no provider-specific services in core code).
- **Portability ("able to shift style later").** Business rules live in a framework-free domain package; the UI talks to the server only through a documented HTTP API; database access goes through repository modules. This allows replacing the UI, the web framework, or adding a mobile app/integrations later without rewriting ticket, routing, or approval rules.

### Technology stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript (strict) everywhere | One language for UI, API, and tests; large hiring pool. |
| Repository | pnpm workspace monorepo: `apps/api`, `apps/web`, `packages/domain`, `packages/contracts` | Shared types, independent deployables, clear boundaries. |
| API | Node.js LTS + NestJS (Fastify adapter), OpenAPI generated from contracts | Modular structure, guards for central authorization, documented API for future integrations. |
| Domain | Plain TypeScript in `packages/domain` (state machines, routing, approval evaluation) | No framework imports; fully unit-testable and portable. |
| Contracts | Zod schemas shared by API and UI | One source of validation truth. |
| Database | PostgreSQL 16 + Prisma ORM and Prisma Migrate | Relational integrity, versioned migrations. |
| Tenant isolation | `tenant_id` on every business table, enforced in the repository layer, plus PostgreSQL row-level security as defence in depth | Shared-database SaaS that cannot leak data across customers. |
| Ticket numbering | Per-tenant, per-type counter row updated with `UPDATE ... RETURNING` inside the ticket-creation transaction | Unique, gap-tolerant, concurrency-safe numbers per customer. |
| Web UI | React + Vite + TypeScript, React Router, TanStack Query, accessible component library (e.g. Radix-based), i18n library from day one | Replaceable SPA, accessible, translatable for future customers. |
| Jobs | pg-boss (PostgreSQL-backed queue) | Notification retries without extra infrastructure. |
| Files | S3-compatible object storage API (MinIO for local development only), ClamAV scanner as a separate service | Works on any cloud or own server. |
| Email | SMTP adapter (Mailpit locally) | Provider-neutral. |
| Auth | Server sessions in httpOnly Secure cookies, Argon2id hashing, CSRF protection, login rate limiting, TOTP MFA (required for administrators) | Secure built-in login; SSO later. |
| Testing | Vitest (unit/integration against real PostgreSQL), Playwright (end-to-end), axe (accessibility) | Acceptance checklist becomes automated tests. |
| Quality gates | ESLint, Prettier, type check, tests, dependency vulnerability audit, and dependency licence check in CI (GitHub Actions proposed) | Production readiness and sellable licensing. |
| Logging | Structured JSON logs (pino) with request IDs; no ticket contents or secrets | Operable without leaking customer data. |

### Commercial-readiness rules

1. Shipped code and dependencies use permissive licences only (MIT, Apache-2.0, BSD, ISC). GPL/AGPL components (e.g. ClamAV, MinIO) run only as separate services or development tools and need a licensing review before bundling with a sold product.
2. No customer names, logos, categories, or departments hard-coded; all come from tenant settings or seed data.
3. Branding (product name, logo, colours) and number prefixes are tenant settings.
4. Tenant provisioning, tenant data export, and tenant deletion are scripted and audited.
5. Platform operators cannot read customer ticket contents without an explicit, audited support-access grant.

### Build agents

Project-level Claude Code agents for implementation are defined in `.claude/agents/`; shared engineering conventions are in `CLAUDE.md`. The primary session remains the orchestrator described in section 20.

## 22. Gap Resolutions — Proposed Defaults

Each item below fills a gap found in the review. All are *proposed* and should be confirmed by the business sponsor; agents implement them as configurable where noted.

| # | Gap | Proposed default |
| --- | --- | --- |
| 1 | Default priority/severity on new tickets | Incidents start at P3/S3, service requests at P4, and are flagged **Untriaged** until an agent confirms them. Untriaged tickets are highlighted in queues. |
| 2 | Customer replies on held or resolved tickets | A customer message on a ticket held for "Awaiting customer" returns it to its previous active state and notifies the assignee. On a Resolved ticket the customer sees **Confirm fixed** (→ Complete) and **Still a problem** (→ In Progress, counts as a reopen). |
| 3 | Automatic closure and reopening | Resolved tickets auto-complete after 5 business days (tenant setting). Completed tickets do not reopen; the employee raises a new ticket linked to the old one. |
| 4 | Employee changes after submission | Employees can cancel their own tickets while Open or Pending Approval, and add messages/attachments until Complete. Classification fields are agent-only after submission. |
| 5 | Approver absence and overdue approvals | Approvers can set an out-of-office delegate with start/end dates. Reminder after 2 business days pending; escalation to the queue owner and administrator after 5 (tenant settings). |
| 6 | VP and manager edge cases | One VP per tenant by default, optionally per department. If the requested-for user's manager is the VP, one VP decision satisfies both stages. Self-approval routes to the configured alternate. |
| 7 | Loading users | Administrator CSV import with validation preview, plus manual add. Users receive an invitation email with a time-limited set-password link. The first administrator is created by a provisioning command. |
| 8 | Requests with several items | One catalog item per service request initially (quantity allowed). Multi-item carts are a later improvement. |
| 9 | Accessibility and browsers | WCAG 2.2 AA. Latest two versions of Chrome, Edge, Firefox, and Safari; responsive down to 360 px width. No native mobile app. |
| 10 | Language and time | English at launch, all UI text externalised for translation. UTC storage, tenant timezone display. |
| 11 | Session and password policy | Idle timeout 30 minutes for staff roles, 8 hours for employees; absolute session limit 12 hours. Minimum 12-character passwords, breached-password check where available, progressive lockout after repeated failures, MFA required for administrators and optional for others. |
| 12 | Watchers / CC | Not in the initial release. |
| 13 | Export | CSV export of list views for agents and administrators in phase 4, limited to records the user may see, and audited. |
| 14 | Retention and privacy law | Configurable retention per record class; defaults set once the applicable data-protection law is confirmed (decision 10). Until then nothing is auto-deleted. |
| 15 | Engineering conventions, testing, CI | Defined in `CLAUDE.md`: repository layout, coding standards, test strategy, seed data, and definition of done. |
| 16 | Multi-company use | Covered by tenant isolation in section 21. The first company is tenant one; there is no cross-tenant UI in the initial release. |
