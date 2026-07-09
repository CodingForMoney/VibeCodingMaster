export function renderRootClaudeHarnessRules(): string {
  return `## VCM Start Here

- Use the durable project docs below as role-relevant project truth.
- Read module-local \`CLAUDE.md\` before editing a subdirectory if one exists.
- Follow the role definition in \`.claude/agents/**\` and use the task skills in \`.claude/skills/**\` when they apply.

## VCM Global Invariants

- Use \`vcm-route-message\` only for PM-hub routes: project-manager dispatches to roles, and roles report questions, results, blockers, and findings back to project-manager. Follow its write-then-stop rule.
- Project-manager runs \`vcm-gate-review\` unconditionally at every Gate Review trigger point and on VCM Gate Review callbacks; the tool reports the authoritative enable state.
- Gate Review must review real task artifacts: architecture plans, review reports, final diffs, generated context, code, tests, docs, and handoff evidence. Do not substitute role claims for artifacts.
- Runtime task records and handoffs under \`.ai/vcm/\` are temporary. Durable facts must move into code, tests, PR text, commit history, or long-term docs.

## VCM Structured Handoffs

- Role handoffs must be written as structured artifacts under \`.ai/vcm/handoffs/\` using the responsible role or skill format.
- Route messages should reference handoff artifacts instead of copying long content.
- Do not replace required handoff artifacts with chat prose.

## VCM Durable Project Docs

- \`docs/GLOSSARY.md\`: abbreviation allowlist for durable comments and docs.
- \`docs/ARCHITECTURE.md\`: project-level architecture; architect-owned.
- \`<module>/ARCHITECTURE.md\`: module-level architecture; architect-owned.
- \`docs/TESTING.md\`: validation strategy, levels, commands, cases, and known testing gaps; reviewer-owned.
- \`docs/known-issues.md\`: durable known issues and accepted limitations; architect-owned.
- \`.ai/generated/module-index.json\`: generated module map.
- \`.ai/generated/public-surface.json\`: generated public surface index.

## VCM Glossary Policy

- \`docs/GLOSSARY.md\` is the only source of truth for abbreviations allowed in durable comments and documentation.
- When writing or editing durable comments or documentation, use only abbreviations listed in \`docs/GLOSSARY.md\`; otherwise write the full term.
- To introduce a new abbreviation, update \`docs/GLOSSARY.md\` before using it.

## VCM Long-Running Validation

- Never run the Bash tool with \`run_in_background: true\`. Never detach a process with \`nohup\`, \`setsid\`, \`disown\`, or a trailing \`&\`. VCM denies these calls.
- The only sanctioned long-running mechanism is the \`vcm-long-running-validation\` skill: \`.ai/tools/run-long-check\` plus \`.ai/tools/watch-job\`.
- The moment a command might run longer than 2 minutes, switch to that skill instead of running the command directly.
- While a job is running, stay in the current turn and keep calling \`.ai/tools/watch-job\` until it reports a terminal result; VCM blocks turn-end while a job is running, and a job without a live watcher is killed automatically.
- Hard ceiling: 60 minutes per job, enforced by the job worker. Do not run or suggest operations expected to exceed 60 minutes without user approval; split larger work first.

## VCM Harness Feedback

- VCM harness includes root \`CLAUDE.md\`, \`.claude/agents/**\`, \`.claude/skills/**\`, \`.ai/tools/**\`, VCM managed blocks, generated-context tooling, routing rules, validation rules, Gate Review rules, Translator rules, and Harness Engineer rules.
- Use \`vcm-report-harness-issue\` when you notice a reusable VCM harness problem. Record concise evidence; do not contact Harness Engineer directly.

## VCM Worktree Policy

- Use one branch, one worktree, one handoff directory, and one PR or final patch per VCM-managed task.
- Roles work sequentially in the same task worktree.
- If \`git status\` shows uncommitted changes, commit them before handing off to another role.
`;
}
