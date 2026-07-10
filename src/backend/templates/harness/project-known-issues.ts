const PROJECT_KNOWN_ISSUES_RULES = `## VCM Known Issues Policy

- Use this file only for confirmed unresolved issues that must survive across tasks.
- Do not record current-task scratch notes, guesses, resolved issues, or ordinary TODOs here.
- During a task, only architect records unresolved findings in \`.ai/vcm/handoffs/known-issues.md\`; other roles report findings through their handoff artifacts.
- At task close, architect promotes only still-relevant confirmed issues from the task-local file into this document.
- Remove entries when they are fixed, rejected, obsolete, or moved into a concrete plan.

## Entry Format

\`\`\`md
## YYYY-MM-DD <short issue title>

- discovered in: <task or PR>
- type: bug | limitation | technical-debt | validation-gap | docs-gap | decision-needed
- impact: low | medium | high
- status: open | planned | accepted
- proposed action: <next useful step>
\`\`\``;

export function renderProjectKnownIssuesRules(): string {
  return PROJECT_KNOWN_ISSUES_RULES;
}

export function renderProjectKnownIssuesSection(): string {
  return `## Open Issues

No known issues.`;
}

export function renderLegacyProjectKnownIssuesTemplate(): string {
  return "# Known Issues\n";
}
