export function renderVcmRouteMessageSkillRules(): string {
  return `## Purpose

Use this skill when project-manager dispatches a VCM role or when a VCM role reports a question, result, blocker, or finding back to project-manager.

This skill writes a route file. It does not deliver the message. VCM backend delivery is triggered later by Claude Code hooks.

## Route Policy

VCM uses project-manager as the routing hub.

Allowed routes:

- \`project-manager -> architect\`
- \`project-manager -> coder\`
- \`project-manager -> reviewer\`
- \`architect -> project-manager\`
- \`coder -> project-manager\`
- \`reviewer -> project-manager\`

Non-PM roles must not route directly to each other. Report questions, blockers, results, findings, or validation evidence back to project-manager. PM decides the next role route.

Allowed message types:

- task
- question
- revise
- cancel
- result
- blocked
- finding

## Route File

Write or update exactly one file:

\`\`\`text
.ai/vcm/handoffs/messages/<from-role>-<to-role>.md
\`\`\`

Use one allowed route above. The file name is authoritative. Do not put from/to in frontmatter and do not create alternate message paths.

If the same route file already contains a not-yet-delivered message, update that file instead of creating a fragmented follow-up.

## Message Format

Use the smallest body that is complete. Include artifact refs instead of copying long documents.

For simple user relay, use a lightweight body instead of the formal dispatch format.

For formal dispatch, blocker, finding, review, or gate routing, use:

\`\`\`md
---
type: task
artifact_refs:
  - .ai/vcm/handoffs/architecture-plan.md
  - docs/plans/example.md
---

Summary:
...

Request or result:
...

Evidence:
...

Expected next action:
...
\`\`\`

## Formal Body Content

Formal messages should include:

- why this message exists
- what the target role should do or what result is being reported
- source of truth or artifact references
- validation or documentation state when relevant
- blocker, decision needed, or next step when relevant

## Turn Rule

After writing or updating the route file, end the current Claude Code turn immediately.

Do not:

- send another message to the same target role in the same turn
- poll route files
- start a shell loop
- wait for another role's answer
- paste directly into another role terminal
- use Claude Code Task/Subagent for VCM role delegation

VCM scans pending route files after the Stop hook and delivers later replies in a new turn.

## Recovery

If delivery is manual, blocked, or the target role is busy, leave the route file non-empty. Do not clear it yourself unless the user or VCM controller has explicitly confirmed manual handling.
`;
}
