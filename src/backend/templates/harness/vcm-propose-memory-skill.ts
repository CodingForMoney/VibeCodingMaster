export function renderVcmProposeMemorySkillRules(): string {
  return `Use this skill only when VCM explicitly requests a memory proposal during Task
Harness Review and provides an exact draft path.

## Rules

- Treat every \`<VCM-memory>\` block as read-only. This skill creates a proposal;
  it never edits active memory.
- Write only to the exact draft path assigned by VCM. The path must be under
  \`.ai/vcm/memory-review/runs/<run-id>/drafts/\` in the active task worktree.
- If VCM did not provide a draft path, do not create a proposal.
- Propose only verified, durable, reusable project knowledge supported by task
  evidence.
- Do not record task narrative, temporary state, unverified conclusions, or
  Harness rules.
- Do not edit handoff artifacts or route messages from this skill.

## Draft Format

\`\`\`markdown
# Memory Proposal
Decision: update | no-change

## Add

## Update

## Remove

## Evidence
\`\`\`

Use \`Decision: no-change\` when the completed task produced no qualifying
memory. End the turn after writing the assigned draft.`;
}
