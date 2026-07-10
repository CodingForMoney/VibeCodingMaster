export function renderVcmReportHarnessIssueSkillRules(): string {
  return `Use this skill when a VCM role notices a reusable harness problem: a tool, skill, role definition, routing rule, validation rule, bootstrap rule, generated-context rule, or VCM managed instruction may be unclear, brittle, incomplete, or repeatedly causing mistakes.

This skill records feedback only. It must not call Harness Engineer directly and must not edit harness files.

## Write Location

Write one markdown file under:

\`\`\`
\${VCM_BASE_REPO_ROOT}/.ai/vcm/harness-feedback/pending/
\`\`\`

If \`VCM_BASE_REPO_ROOT\` is not set, do not guess a fallback path. Report the
environment problem to project-manager so VCM can retry with the correct base
repository root.

Use a filename like:

\`\`\`
<UTC timestamp>-<reporter-role>-<short-slug>.md
\`\`\`

Use only safe filename characters: letters, numbers, dot, dash, and underscore.

## Required Content

Use this structure:

\`\`\`md
# <short problem title>

- Reporter role: <role>
- Task slug: <slug or unknown>
- Summary: <one line>
- Observed problem: <what happened>
- Expected behavior: <what the harness should have done>
- Evidence: <file paths, command names, logs, or repeated failure pattern>
- Suspected harness area: <skill, role definition, tool, routing, validation, bootstrap, or managed instruction>
- Impact: <who is affected and how>
- Urgency: low | medium | high
\`\`\`

## Constraints

- Keep the report concise and factual.
- Include enough evidence for Harness Engineer to verify the issue.
- Do not include secrets, private logs, or unnecessary source content.
- Continue the current VCM role work after writing the report unless the original task is blocked.
`;
}
