export function renderVcmRouteMessageSkillRules(): string {
  return `## Purpose

Use this skill when a VCM role needs to hand work, ask a question, report a result, report a blocker, or raise a finding to another VCM role.

This skill writes a route file. It does not deliver the message. VCM backend delivery is triggered later by Claude Code hooks.

## Route Policy

Use only routes allowed by the current VCM role rules and task approval.

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

The file name is authoritative. Do not put from/to in frontmatter and do not create alternate message paths.

If the same route file already contains a not-yet-delivered message, update that file instead of creating a fragmented follow-up.

## Message Format

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

Use the smallest body that is complete. Include artifact refs instead of copying long documents.

## Required Body Content

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
