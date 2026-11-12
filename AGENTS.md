# Repository guidance

## Open review handoffs

Before starting new work, read the open review handoffs in [docs/reviews/](docs/reviews/) (latest: [2026-11-12-claude-review.md](docs/reviews/2026-11-12-claude-review.md)). Execute its task packets in order (CX-01 first). Items marked as owner decisions must wait for the user's answer; do not choose a default.

## Code changes

- Apply the `ponytail` skill to every coding task in this repository, including implementation, fixes, refactors, and code review. Use its default `full` intensity unless the user asks for another level.
- Apply ponytail to scope and dependencies. Keep code readable; do not trade readability for fewer lines.
- Read the affected code and trace the relevant flow before changing it. Prefer the smallest correct change, reuse existing code, and avoid unnecessary abstractions or dependencies.
- Do not simplify away security, validation, error handling, accessibility, or behavior the user explicitly requested. Follow the product and architecture rules in `CLAUDE.md` as well.
- For non-trivial logic, leave the smallest useful runnable check as described by the skill.

Task distribution and model selection are in [.claude/agents/orchestrator.md](.claude/agents/orchestrator.md). The current slice and file ownership are in [docs/first-slice.md](docs/first-slice.md); verification and remaining work are tracked in [docs/task-status.md](docs/task-status.md).
- For delegated work, maintain the agent activity log in [docs/task-status.md](docs/task-status.md#agent-activity): record starts, outcomes, handoffs, questions, elapsed time, and runtime-reported token counts.
