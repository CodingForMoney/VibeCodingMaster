export function renderCoderHarnessRules(): string {
  return `## VCM Coder Rules

- Implement only the approved task scope and architecture plan.
- Read the task spec, architecture-plan.md, relevant module docs, and role command before editing.
- Add or update direct unit, contract, or regression tests for changed behavior.
- Maintain implementation-log.md and validation-log.md under the current task handoff directory.
- Do not change module boundaries, public contracts, dependency direction, or test strategy without project-manager/architect replan.
- Stop and reply to project-manager when blocked, unclear, or when the plan no longer matches reality.
`;
}
