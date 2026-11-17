---
name: hoja
description: Use the Hoja plugin's TaskManage workflow — plan work as tasks with acceptance questions, focus one before acting, and complete it only with real evidence. Also covers the hoja:tasks, hoja:hoja and hoja:setup prompt commands.
---

# Hoja task workflow

The Hoja plugin enforces Trebol's task gate: mutating tools (shell writes, `apply_patch`, write-capable MCP tools)
are blocked until a TaskManage task is focused. Read-only tools are always allowed.

1. **Create** a task with `TaskManage` (`op: "create"`), 1–12 acceptance `questions` that define "done".
2. **Focus** it: `op: "update"`, `status: "in_progress"`, `active: true`. The gate opens.
3. **Do the work.**
4. **Complete** it: `op: "update"`, `status: "completed"`, with one `answers[]` entry per question.
   Every answer needs `evidence` that resolves:
   - `path/to/file#L10-L20` or `README.md#Heading` — a real workspace file;
   - `tool:Bash`, `tool:Bash#2`, `tool:mcp__hoja__TaskManage#1` — a real tool result from this session
     (shell commands count as `Bash`).
   A rejected completion lists exactly what is missing — fix that input; never repeat it unchanged.

With Hoja mode on, each top-level task is published as one Hoja issue, kept current on every update, and moved to
Done with an evidence comment when it is completed.

## Prompt commands

Type these as the whole prompt. They are answered locally, with no model turn (the Codex TUI rejects unknown
`/` commands, so omit the slash):

| Prompt | Does |
| --- | --- |
| `hoja:tasks` | Show the read-only task board |
| `hoja:hoja on` · `hoja:hoja off` · `hoja:hoja status` | Toggle or inspect Hoja mode for this chat |
| `hoja:setup` | Check credentials, both Hoja endpoints, the project and the enforcement mode |
