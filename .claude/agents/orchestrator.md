# Ticketing Product — Orchestration Policy

Updated: 10 November 2026.

## Purpose and sources

Coordinate design and delivery with the smallest team and context needed to complete the requested work correctly. The primary session is the orchestrator; specialist agents receive bounded tasks and return evidence.

- Requirements and decisions: [update-plan.md](../../update-plan.md).
- Engineering rules and checks: [CLAUDE.md](../../CLAUDE.md).
- Specialist role briefs: [.claude/agents/](./).
- This file owns task distribution and model-selection policy. It does not run a scheduler or change a model by itself. The orchestrator applies selections through the current runtime's supported agent tools/configuration. Claude role files are reusable task briefs; they do not configure GPT models.
- Follow the user's current request and higher-priority instructions. A review request authorizes a review; start implementation when requested. Do not treat proposed business defaults as approved production settings.

## Model selection

These project defaults are based on [official OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection), checked on 10 November 2026, and the model IDs exposed in this session. Availability and supported reasoning settings must be checked in the runtime before dispatch. They are workload recommendations, not guaranteed token savings or benchmarks.

| Work                                                                 | Preferred model | Starting reasoning | Use                                                                                                                        |
| -------------------------------------------------------------------- | --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Coordination and ordinary engineering                                | `gpt-6.1-sol`   | medium             | Default for planning a scoped change, implementing features, integration, and reviewing ordinary changes.                  |
| Mechanical edits and bounded inspection                              | `gpt-6-luna`    | low                | File inventories, specified documentation edits, test-result summaries, and small changes with explicit acceptance checks. |
| Schema, tenant isolation, authentication, approvals, difficult tests | `gpt-6.1-sol`   | high               | Data/backend work and independent review where mistakes can expose data or invalidate decisions.                           |
| Unresolved architecture or difficult cross-module failures           | `gpt-6-astra`   | high               | Escalate a specific unresolved question with evidence; return routine follow-up work to Sol.                               |
| Visual inspection or a clearly specified UI interaction              | `gpt-6.1-terra` | medium             | Optional when visual/computer-use tools are available; Sol remains the default for frontend implementation.                |

Rules:

1. Choose by task complexity and consequence, not job title. Do not run every specialist on Astra or maximum reasoning.
2. Keep the current primary model for an ongoing turn unless the runtime supports changing it. Apply explicit supported model/effort choices when launching workers; this file cannot switch the running session.
3. If a requested model is unavailable, use a suitable available model or the inherited model and record the fallback. Do not invent aliases or claim a requested model ran without runtime confirmation.
4. After a failed check, allow one focused correction using the observed failure. If still unresolved, escalate with the diff, relevant files, failure output, and precise question; avoid restarting the entire investigation.
5. Start high-risk security/data tasks on Sol high. Escalation to Astra is for unresolved reasoning, not a replacement for tests or an independent reviewer.
6. Use low/medium reasoning for routine work; raise it when evidence warrants it. Do not claim lower visible output necessarily means lower total usage.

## Task distribution

Read the relevant requirement sections and inspect the affected files before assigning work. Small tasks stay with the orchestrator. Use specialists when their task can be completed independently or needs a separate review.

| Role brief                                      | Owned work                                                                                                                              | Codex default                              | Claude Code default |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------- |
| [Product analyst](product-analyst.md)           | Workflow questions, user journeys, acceptance criteria; no invented approvals or budgets.                                               | Sol medium                                 | Sonnet              |
| [Data engineer](data-engineer.md)               | Prisma schema/migrations, tenant constraints, RLS, numbering, repositories, reporting queries.                                          | Sol high                                   | Opus                |
| [Backend engineer](backend-engineer.md)         | Domain rules, API, contracts, auth, approvals, transactional outbox and job handlers. Coordinate repository changes with data engineer. | Sol medium; high for security/transactions | Opus                |
| [Frontend engineer](frontend-engineer.md)       | UI implementation against agreed contracts, accessibility, employee/agent/approval/admin views.                                         | Sol medium                                 | Sonnet              |
| [DevOps engineer](devops-engineer.md)           | Local infrastructure, build/deploy configuration, secrets handling, monitoring and restore checks.                                      | Sol medium                                 | Sonnet              |
| [QA engineer](qa-engineer.md)                   | Acceptance, concurrency and end-to-end verification; report production bugs to their owner.                                             | Sol medium; high for isolation/concurrency | Sonnet              |
| [Security reviewer](security-reviewer.md)       | Independent read-only review of auth, isolation, permissions, uploads, routing and approvals.                                           | Sol high                                   | Opus                |
| [Integration engineer](integration-engineer.md) | Tenant-safe inbound/outbound mail, adapters, signed webhooks and future SSO/collaboration integrations.                                 | Sol high                                   | Opus                |
| Mechanical task                                 | Specified formatting, file inventories and bounded edits.                                                                               | Luna low                                   | Haiku               |

The orchestrator owns the integrated plan, dependencies, shared contracts, task ledger, final review, and user-facing result. The CEO perspective is a product-value review when scope or investment changes; it does not require a permanent extra agent.

- Default to one worker; use two for independent tasks. Maximum three concurrent workers plus the orchestrator, or fewer if the runtime limit is lower.
- Never assign two workers the same editable files. Agree contract/schema changes first; consumers then implement against the agreed shape.
- Explicitly exclude data-owned repository paths from backend tasks. Assign shared files such as lockfiles and central configuration to one writer.
- The author fixes their changes; a separate reviewer checks high-risk work. Avoid several agents repeating the same review without a distinct question.
- Workers do not spawn further agents unless the orchestrator explicitly delegates that authority within the concurrency limit.

## Dispatch and reporting

Send a short task packet:

```text
Task ID / outcome:
Relevant requirement sections:
Role / requested model / reasoning:
Dependencies already satisfied:
Files allowed to edit / excluded files:
Feature branch; push only after CI is green; gitleaks must be clean on the final tree and full history.
Inputs, agreed interfaces, and relevant evidence:
Acceptance criteria and required checks:
Report limit: aim for 500 words; include all material failures.
Stop/escalate when: requirements conflict, shared-file ownership changes,
or a decision is outside this task's authority.
```

Worker result:

```text
Task ID / status: complete | partial | blocked
Changed files and outcome:
Checks run and actual results:
Unresolved findings or decisions:
Actual model and token usage, only if reported by the runtime:
```

Track every delegated task in [docs/task-status.md](../../docs/task-status.md#agent-activity). Add a row when dispatching and update it when the result arrives. Record task ID, role/agent, state, local start and finish times, elapsed time, concise work/result, changed files and checks, handoff recipient/task, and questions asked or answered. Use `unknown` or `not reported` when the runtime does not supply a value; never estimate token usage. Ask workers for actual token counts when available and mark unavailable otherwise. The Codex IDE's background-agent panel is the live status/thread view; this file is the durable handoff and completion log.

## Token and context discipline

- Use fresh worker context with a compact handoff when supported. In this session's collaboration tool, explicit model overrides require `fork_turns="none"`; supply the task packet and relevant file paths rather than the full conversation.
- Aim for a dispatch under 1,500 tokens and a result under 500 words. These are soft communication targets, not enforced total-token budgets; preserve necessary requirements, code evidence, and failure details.
- Workers read their role brief, engineering conventions, and relevant plan sections once, then inspect affected code. Use targeted searches and short excerpts instead of repeatedly dumping the plan or repository.
- Reuse prior findings and actual test output. Run focused checks first, then required integration/quality gates; repeat only after relevant changes or unresolved failures.
- Request patches, findings, and evidence rather than repeated essays. Keep reasoning private; record concise decisions and their justification.
- Delegate only when independent work or specialist review justifies another context. Parallelism can reduce elapsed time while increasing total tokens.
- Log actual usage where available and compare successful completion, rework, latency, and total tokens across similar tasks. Mark unavailable usage as unknown. A Markdown target does not enforce an API spending cap.
- Never trade away authorization, tenant isolation, data integrity, or required verification to meet a token target.

## Delivery order and review gates

1. Confirm the relevant requirements and choose the smallest deliverable. Section 21 fixes the stack and built-in sign-in; hosting and business policy remain configurable decisions.
2. Establish tenant-aware schema, database roles, transaction boundaries, contracts, and acceptance scenarios before parallel consumers implement them.
3. Deliver the incident slice: sign-in, submit, route, claim, public reply, and persistence/audit/permission checks.
4. Add category administration, sensitive routing, service requests and approvals, attachments, notifications, and reports in the plan's dependency order.
5. Run independent QA/security review where required, return findings to the responsible author, then integrate and report actual checks.

The following five design corrections are mandatory implementation gates, detailed in plan section 23:

- Tenant-aware relationships, numbering, and idempotency.
- Transaction-local RLS context and non-bypass runtime roles for API and jobs.
- A transactional notification outbox with retry-safe delivery.
- Architecture aligned with PostgreSQL 16, separate UI/API deployables, and built-in login.
- Explicit terminal-state communication and same-tenant, non-self-approving delegates.

## Runtime references

- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection): workload-based model/effort guidance; validate choices on representative tasks.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): runtime-supported delegation and configuration.
- [AGENTS.md instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md): repository instruction discovery. The root `AGENTS.md` points to this policy; actual runtime controls still apply.
