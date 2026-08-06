export function renderVcmCodeNavigationSkillRules(): string {
  return `## Purpose

Use this skill when Architect, Coder, or Reviewer must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Navigation Order

1. Define the affected feature or module boundary and locate entry symbols with \`.ai/generated/module-index.json\` and \`.ai/generated/public-surface.json\` when available.
2. Use LSP workspace or file symbols, definitions, implementations, references, and incoming or outgoing call hierarchy to resolve project-owned relationships.
3. Read the complete project-owned callable unit at every resolved location.
4. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
5. Use Glob, generated context, architecture documents, and runtime evidence to locate dynamic registrations, configuration or string edges, macros, documentation, and external boundaries that LSP does not model.

## Evidence

- Record each resolved relationship and whether it came from LSP, runtime evidence, an external boundary, or a generated boundary.
- When an empty LSP result contradicts a direct call in the code, another LSP result, or runtime evidence, treat the relationship as unresolved. Record the contradiction and use exact fallback evidence.
- If LSP is unavailable or cannot resolve a required project-owned relationship, record that limitation and leave the relationship unresolved. Do not substitute text search for semantic navigation.
- Do not use the Grep tool or shell text-search commands such as \`grep\`, \`rg\`, or \`git grep\`.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.`;
}
