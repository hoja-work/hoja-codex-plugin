---
name: hoja
description: Use the Hoja plugin's TaskManage workflow — register every user request as a task (deliverables as sub-issues), plan work as tasks with acceptance questions, focus one before acting, and complete it only with real evidence. Also covers the hoja:tasks, hoja:hoja, hoja:trace and hoja:setup prompt commands.
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

## Register work without being asked

The user should never have to remind you to track work or update a task.

- **Every request that changes files or state gets a task before you act**, not only long work. Short follow-ups
  ("commit everything", "update both READMEs", "merge and deploy") are requests too.
- **One request, several deliverables:** one root task plus one child per deliverable (`parentTaskId`, in the same
  batch). With Hoja mode on, the root becomes one issue and each child becomes its sub-issue.
- **A new message outside the active task:** create a new root task for it (or a child, if it serves the same
  goal). Never fold a new request into an unrelated task.
- **`metadata: {"hoja":"local"}`** is for mechanical steps under a parent (run the tests, push). Never put it on a
  user request: that request then never reaches Hoja.
- **Before you end a reply:** complete each finished task with evidence, or `addNote` what is left. If you forget,
  the plugin continues your turn once with a reminder.

With Hoja mode on, each top-level task is published as one Hoja issue (and each child of it as a sub-issue), kept current on every update, and moved to
Done with an evidence comment when it is completed. That completion also attaches this session's trace (turns, model
calls with tokens, every tool call and gate block) to the issue; the TaskManage result says so. The `hoja_trace`
tool's `summary` only reads; `upload` is a write and needs a focused task.

## Prompt commands

Type these as the whole prompt. They are answered locally, with no model turn (the Codex TUI rejects unknown
`/` commands, so omit the slash):

| Prompt | Does |
| --- | --- |
| `hoja:tasks` | Show the read-only task board |
| `hoja:hoja on` · `hoja:hoja off` · `hoja:hoja status` | Toggle or inspect Hoja mode for this chat |
| `hoja:trace` · `hoja:trace upload HOJA-123` · `hoja:trace path` | This session's trace: summary, attach it to an issue now, or the JSON file's path |
| `hoja:setup` | Check credentials, both Hoja endpoints, the project and the enforcement mode |

If a prompt command comes back as instructions instead of an answer, the hook could not reach the plugin server. Then
call the read-only `hoja_setup` tool and show its output — it prints the same report as `hoja:setup`. Read-only
discovery is never gated: `hoja_project action:list`, `hoja_viewer`, `hoja_teams` and the other hosted API reads pass
without a task, so a health check never needs an issue.
