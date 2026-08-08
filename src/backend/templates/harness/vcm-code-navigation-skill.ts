export function renderVcmCodeNavigationSkillRules(): string {
  return `## Purpose

Use this skill when Architect must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Navigation Order

1. Define the affected feature or module boundary and locate entry symbols with \`.ai/generated/module-index.json\` and \`.ai/generated/public-surface.json\` when available.
2. Use LSP workspace or file symbols, definitions, implementations, references, and incoming or outgoing call hierarchy to resolve project-owned relationships. If \`LSP\` is unavailable, report a VCM LSP configuration failure instead of substituting text search.
3. If an initial workspace-symbol request is empty or reports indexing, wait and retry; startup or indexing time does not permit replacing a required semantic query with text matching. Retry the same bounded workspace query at most two more times. If it still cannot resolve, record the operation and result as unresolved.
4. Read the complete project-owned callable unit at every resolved location.
5. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
6. Use Glob, generated context, architecture documents, and runtime evidence to locate dynamic registrations, configuration or string edges, macros, documentation, and external boundaries that LSP does not model.

## Evidence

- Record each resolved relationship and whether it came from LSP, runtime evidence, an external boundary, or a generated boundary.
- When an empty LSP result contradicts a direct call in the code, another LSP result, or runtime evidence, treat the relationship as unresolved. Record the contradiction and use exact fallback evidence.
- If LSP is unavailable or cannot resolve a required project-owned relationship, record that limitation and leave the relationship unresolved.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.`;
}
