import type { VcmMemoryRoleName } from "../../../shared/types/memory.js";

export function renderRoleMemoryRules(role: VcmMemoryRoleName): string {
  const proposalRule = role === "harness-engineer"
    ? `Treat the \`<VCM-memory>\` block in this role definition as read-only during
role turns. Update reviewed memory only through the output paths assigned by VCM
or explicit user edits in Harness Studio. When Auto Memory is disabled, do not
initiate memory proposals, reviews, or updates.`
    : `Treat the \`<VCM-memory>\` block in this role definition as read-only. Only
when VCM explicitly requests a proposal during Task Harness Review, use
\`vcm-propose-memory\` and write the exact assigned draft path.`;

  return `### Role Memory

The \`<VCM-memory>\` block in this role definition is accumulated project context,
not authority. Verify it against current code, documentation, and task evidence.

${proposalRule}`;
}
