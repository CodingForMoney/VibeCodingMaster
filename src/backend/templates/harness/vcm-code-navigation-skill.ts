export function renderVcmCodeNavigationSkillRules(): string {
  return `## Purpose

Use this skill when Architect or Reviewer must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Navigation Order

1. Define the affected feature or module boundary and locate entry symbols with \`.ai/generated/module-index.json\` and \`.ai/generated/public-surface.json\` when available.
2. When LSP is available, use workspace or file symbols, definitions, implementations, references, and incoming or outgoing call hierarchy to resolve project-owned relationships.
3. Read the complete project-owned callable unit at every resolved location.
4. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
5. Use structural search when available, and use Grep for dynamic registrations, configuration or string edges, macros not resolved by LSP, documentation, and explicit fallback discovery.

## Evidence

- Record each resolved relationship and whether it came from LSP, structural search, Grep fallback, runtime evidence, or a generated boundary.
- Do not treat a Grep result as proof of a complete definition, caller, implementation, or reference set when LSP is available.
- If LSP is unavailable or cannot resolve a relationship, record that limitation and the exact fallback evidence. Do not describe text-search results as compiler-accurate or complete.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.`;
}
