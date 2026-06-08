export function renderKnownIssuesDocHarnessRules(): string {
  return `## VCM Known Issues Policy

- Use this file only for confirmed unresolved issues that must survive across tasks.
- Do not record current-task scratch notes, guesses, resolved issues, or ordinary TODOs here.
- During a task, record unresolved findings in \`.ai/vcm/handoffs/known-issues.md\` first.
- At task close, promote only still-relevant confirmed issues from the task-local file into this document.
- Remove entries when they are fixed, rejected, obsolete, or moved into a concrete plan.

## Entry Format

\`\`\`md
## YYYY-MM-DD <short issue title>

- discovered in: <task or PR>
- type: bug | limitation | technical-debt | validation-gap | docs-gap | decision-needed
- impact: low | medium | high
- status: open | planned | accepted
- proposed action: <next useful step>
\`\`\`
`;
}
