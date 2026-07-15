import type { VcmMemoryRoleName } from "../../../shared/types/memory.js";

export function renderRoleMemoryRules(role: VcmMemoryRoleName): string {
  const proposalRule = role === "harness-engineer"
    ? `Treat \`.ai/vcm/memory/**\` as read-only during role turns. Update memory
only through VCM-assigned Memory Review output paths or explicit user edits in
Harness Studio. When Auto Memory is disabled, do not initiate memory proposals,
reviews, or updates.`
    : `Treat \`.ai/vcm/memory/**\` as read-only. Do not create, edit, or delete
memory files. Only when VCM explicitly requests a proposal during Task Harness
Review, use \`vcm-propose-memory\` and write the exact assigned draft path.`;

  return `### Role Memory

Before handling work in a session, read \`.ai/vcm/memory/roles/${role}.md\`.
Read it again after context compaction before continuing.

Treat memory as accumulated project context, not authority. Verify it against
current code, documentation, and task evidence.

${proposalRule}`;
}
