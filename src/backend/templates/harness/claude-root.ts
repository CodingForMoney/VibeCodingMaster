export function renderRootClaudeHarnessRules(): string {
  return `## VCM Shared Rules

- This repository uses VibeCodingMaster for multi-session Claude Code work.
- User-facing work starts with the project-manager role.
- Canonical task handoffs live under .ai/handoffs/<task-slug>/.
- Use only the current task's handoff directory for task-specific artifacts.
- Do not create or write .ai/handoffs/<other-task>/ for the current task.
- Use vcmctl for role-to-role messaging instead of asking the user to copy prompts.
- Non-PM roles only reply to project-manager; they do not message other roles directly.
- High-risk decisions involving schema, auth, permissions, payment, billing, security, data deletion, or unclear user intent must stop for project-manager/user approval.
- Required workflow gates: architect plan -> coder implementation/validation -> reviewer review -> architect docs sync -> project-manager final acceptance/commit/PR.
`;
}
