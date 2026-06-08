export function renderVcmHarnessMaintenanceSkillRules(): string {
  return `## Purpose

Use this skill when VCM needs an AI-assisted harness drift audit or cleanup recommendation.

This skill is an audit and maintenance procedure. It does not replace deterministic VCM upgrades, migrations, managed-block replacement, or uninstall.

## Boundaries

- Inspect harness state, durable docs, role rules, skills, validation tools, PR template, generated artifacts, and runtime cleanup candidates.
- Do not silently rewrite VCM managed blocks, hooks, manifests, or uninstall behavior.
- Do not edit product source code.
- Recommend deterministic VCM backend actions when managed files, hooks, manifest entries, or uninstall behavior need changes.
- Remove or update obsolete project-specific harness content only when the user explicitly requests it.

## Procedure

1. Read \`CLAUDE.md\`, \`.claude/agents/*.md\`, \`.claude/skills/*.md\`, \`.github/pull_request_template.md\`, durable docs, \`.ai/tools/*\`, and \`.ai/vcm-harness-manifest.json\` when present.
2. Check for stale docs, obsolete file references, duplicate rules, missing owners, placeholder validation tools, old runtime state, and drift from the current VCM harness baseline.
3. Run relevant harness checks when available, such as \`.ai/tools/check-docs-freshness\` and \`.ai/tools/check-agent-rules\`.
4. Classify findings as safe local cleanup, project-specific update, deterministic VCM upgrade, user decision, or no action.
5. Report recommended actions with evidence and risk.

## Output

Summarize:

- files inspected
- drift findings
- stale or obsolete harness content
- validation tool gaps
- cleanup candidates
- recommended deterministic VCM actions
- user decisions needed

If invoked inside a VCM task, record confirmed durable issues in \`.ai/vcm/handoffs/known-issues.md\` only when they should survive task cleanup.
`;
}
