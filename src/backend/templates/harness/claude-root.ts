export function renderRootClaudeHarnessRules(): string {
  return `## VCM Shared Rules

- This repository uses VibeCodingMaster for multi-session Claude Code work.
- User-facing work starts with the project-manager role.
- Canonical task handoffs live under .ai/vcm/handoffs/ inside the current task runtime repo.
- Use only the current task's handoff directory for task-specific artifacts.
- Do not create or write task handoffs outside .ai/vcm/handoffs/ for the current task.
- Use route files under .ai/vcm/handoffs/messages/ for role-to-role messaging instead of asking the user to copy prompts.
- A role-to-role call is represented by exactly one file named <from-role>-<to-role>.md, such as project-manager-coder.md or coder-project-manager.md.
- If you need to revise a not-yet-delivered message to the same target, update that route file instead of creating another message.
- Non-PM roles only reply to project-manager; they do not message other roles directly.
- Role messaging is turn-based: do not send more than one active message to the same target role.
- After writing a route file for another role, end the current Claude Code turn. Treat the file write as the final coordination action of this turn.
- Do not poll files, start shell loops, or keep the turn open waiting for another role's answer. VCM scans pending route files after your Stop hook and delivers later replies in a new turn.
- Do not use Claude Code Task/Subagent for VCM role delegation; VCM owns the four role sessions and the message queue.
- If new information arrives while a role is still processing, update the relevant handoff artifact or wait; do not spam the target role's terminal.
- High-risk decisions involving schema, auth, permissions, payment, billing, security, data deletion, or unclear user intent must stop for project-manager/user approval.
- Required workflow gates: architect plan -> coder implementation/validation -> reviewer review -> architect docs sync -> project-manager final acceptance/commit/PR.
`;
}
