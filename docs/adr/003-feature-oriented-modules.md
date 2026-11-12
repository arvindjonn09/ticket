# ADR 003: Feature-oriented application modules

- Status: Accepted
- Date: 2026-11-12

## Context

The API and web application had grown around flat source directories. Business areas
were difficult to locate, and the web entry point had accumulated page components.
The project needs a predictable home for feature code while keeping contracts and
database behavior stable.

## Decision

Organize API code under `apps/api/src/modules/<feature>/` and web code under
`apps/web/src/workspaces/{employee,support,approver,admin}/` with shared UI in
`shared/`. Keep application entry points focused on framework setup and routing.
Move domain rules into `packages/domain` when a feature is changed. Use Prettier
with a 100-column print width and enforce formatting and lint checks in CI.

## Consequences

Feature changes should keep their controller, service, repository, and tests near
the feature where practical. Existing APIs and database schemas remain unchanged
by structural moves. ESLint warns on files over 400 lines and complexity above 15;
large files are split when touched. Ponytail guides scope and dependencies, while
readability takes priority over line count.
