export function renderGitignoreHarnessRules(): string {
  return [
    "# VCM local app state, task metadata, session records, and task worktrees.",
    ".ai/vcm/",
    ".claude/worktrees/"
  ].join("\n");
}
