export function renderVcmProposeMemorySkillRules(): string {
  return `Use this skill only when VCM explicitly requests a memory proposal or
planning-session memory candidate and provides an exact path.

## Rules

- Treat every \`<VCM-memory>\` block as read-only. This skill creates a proposal;
  it never edits active memory.
- Submit only to the exact path assigned by VCM. It must be either a role draft
  under \`.ai/vcm/memory-review/runs/<run-id>/drafts/\` or a planning candidate
  under \`.ai/vcm/memory-review/candidates/\` in the active task worktree.
- If VCM did not provide a path, do not create a proposal.
- Propose only verified, durable, reusable project knowledge supported by task
  evidence.
- Target shared project knowledge to \`shared\`. Target knowledge used only by
  the current role to \`current-role\`.
- For every add or update, explain why the memory is necessary, what future
  impact its absence would have, and whether the knowledge belongs in memory,
  a durable document, or a short memory reference to a durable document.
  Use exactly \`memory\`, \`durable-doc\`, or \`memory-reference\`. Use
  \`Durable doc path: none\` with \`memory\` and an actual path with either
  durable-document disposition.
- Do not record task narrative, temporary state, unverified conclusions, or
  Harness rules.
- Do not edit handoff artifacts or route messages from this skill.

## Draft Format

Use this exact format for \`Decision: no-change\`:

\`\`\`markdown
# Memory Proposal
Decision: no-change

## Add
none

## Update
none

## Remove
none
\`\`\`

For \`Decision: update\`, use one or more numbered items and write every field
on one line. Use \`none\` as the complete body of an operation section that has
no item:

\`\`\`markdown
# Memory Proposal
Decision: update

## Add
### Item 1
Target: shared
Content: <new memory entry>
Reason: <why this must remain available across tasks>
Impact if absent: <specific future role or task failure>
Durable doc disposition: memory
Durable doc path: none
Evidence: <task artifact, code, or durable documentation>

## Update
### Item 1
Target: current-role
Existing: <exact existing memory entry>
Content: <replacement memory entry>
Reason: <why the replacement must remain available across tasks>
Impact if absent: <specific future role or task failure>
Durable doc disposition: memory-reference
Durable doc path: docs/ARCHITECTURE.md
Evidence: <task artifact, code, or durable documentation>

## Remove
### Item 1
Target: current-role
Existing: <exact existing memory entry>
Evidence: <task artifact, code, or durable documentation>
\`\`\`

Use \`Decision: no-change\` when the completed task produced no qualifying
memory. Write the proposal to a candidate outside \`.ai/vcm\`, submit it with
\`.ai/tools/vcm-artifact memory-proposal --file <candidate> --path <assigned-path> --mode final\`,
and end the turn only after VCM accepts it.`;
}
