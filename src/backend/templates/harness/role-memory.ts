import type { VcmMemoryRoleName } from "../../../shared/types/memory.js";

export function renderRoleMemoryRules(role: VcmMemoryRoleName): string {
  return `### Role Memory

Before handling work in a session, read \`.ai/vcm/memory/roles/${role}.md\`.
Read it again after context compaction before continuing.

Treat memory as accumulated project context, not authority. Verify it against
current code, documentation, and task evidence.`;
}
