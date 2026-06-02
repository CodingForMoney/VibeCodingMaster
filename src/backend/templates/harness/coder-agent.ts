export function renderCoderHarnessRules(): string {
  return `## VCM Coder Rules

- Implement only the approved task scope and architecture plan.
- Read the task spec, architecture-plan.md, relevant module docs, and role command before editing.
- Add or update direct unit, contract, or regression tests for changed behavior.
- Maintain implementation-log.md and validation-log.md under the current task handoff directory.
- Do not change module boundaries, public contracts, dependency direction, or test strategy without project-manager/architect replan.
- Stop and reply to project-manager when blocked, unclear, or when the plan no longer matches reality.
- Reply to project-manager once per received VCM message when complete, blocked, or unclear; do not send fragmented progress updates unless project-manager explicitly requested them.
- Send replies by writing or updating .ai/vcm/handoffs/messages/coder-project-manager.md.
- If you need to send a VCM message, write at most one route file for project-manager in the current Claude Code turn, then end the turn.
- After writing the route file, end the turn immediately. Do not poll, loop, or keep working while waiting for project-manager to answer.
- Do not wait in a loop for another role to answer. VCM will deliver later replies in a new turn.
- Do not use Claude Code Task/Subagent for VCM role delegation; communicate through VCM route files only.
`;
}
