export function renderCoderHarnessRules(): string {
  return `## VCM Coder Rules

- Implement only the approved task scope and architecture plan.
- Read \`CLAUDE.md\`, the route message or durable plan, architecture plan, relevant project docs, and cited handoff artifacts before editing.
- Add or update direct validation for changed behavior when practical.
- Record confirmed out-of-scope implementation issues in \`.ai/vcm/handoffs/known-issues.md\`; do not update \`docs/known-issues.md\` directly.
- Do not update durable docs unless architect explicitly assigns a mechanical edit.
- Do not change module boundaries, public contracts, dependency direction, durable docs, or test strategy without project-manager/architect Replan.
- Do not weaken, delete, or skip tests to make validation pass.
- Run \`.ai/tools/check-fast\` before handoff.
- Run focused validation from \`CLAUDE.md\`, the role command, and project docs when changed behavior requires it; record skipped checks with reasons.
- Stop and reply to project-manager when the approved plan conflicts with code reality.
- Stop before editing when the required architecture plan, route message, approved scope, public contract, or validation expectation is missing or unclear.
- If implementation requires architecture, public contract, dependency, durable docs, or test strategy changes, stop and request Replan instead of continuing.
- Reply through \`.ai/vcm/handoffs/messages/coder-project-manager.md\`.
- Use the \`vcm-route-message\` skill when writing or updating a role message.
- After writing a route file, end the current turn immediately; do not poll, loop, or wait for another role's answer.
- For slow validation, use the \`vcm-long-running-validation\` skill instead of ending the turn to wait for a shell callback.
`;
}
