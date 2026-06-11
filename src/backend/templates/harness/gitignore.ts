export function renderGitignoreHarnessRules(): string {
  return [
    "# VCM runtime task metadata, handoffs, session records, logs, and task worktrees.",
    ".ai/vcm/",
    ".claude/worktrees/",
    ".ai/tools/__pycache__/"
  ].join("\n");
}
