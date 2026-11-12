# Project instructions

Read [orchestrator.md](orchestrator.md) for task distribution, model selection, and context discipline, and [CLAUDE.md](../../CLAUDE.md) for shared engineering conventions. Read only the relevant sections of [update-plan.md](../../update-plan.md) for the task.

The primary session coordinates work. Use the specialist briefs in `.claude/agents/` as task instructions when needed; their tool frontmatter belongs to Claude Code and is not Codex runtime configuration. Keep small tasks local and give delegated tasks bounded file ownership and acceptance checks.

Use the models and reasoning efforts in `orchestrator.md` only when supported by the current runtime, subject to user and higher-priority instructions. Record fallbacks and actual verification honestly. Application implementation starts when requested; planning changes do not mark implementation complete.
