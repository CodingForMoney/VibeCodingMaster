---
name: vcm-code-navigation
description: Use when Architect must resolve code symbols, references, implementations, call hierarchies, or bounded dependency paths.
---

# VCM Code Navigation Skill

## Purpose

Use this skill when Architect must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Navigation Order

1. Define the affected feature or module boundary and locate entry symbols with `.ai/generated/module-index.json` and `.ai/generated/public-surface.json` when available.
2. Use LSP workspace or file symbols, definitions, implementations, references, and incoming or outgoing call hierarchy to resolve project-owned relationships. If `LSP` is unavailable, report a VCM LSP configuration failure instead of substituting text search.
3. Treat LSP results as symbol-specific. An accessor, backing field, trait declaration, implementation method, wrapper, and alias are separate symbols. Query every relevant symbol separately. When starting from an accessor or wrapper, read its implementation, resolve the backing field, delegate, or trait item with LSP, then query those symbols too. Never use one symbol's references as proof of a complete semantic class.
4. If an initial workspace-symbol request is empty or reports indexing, wait and retry; startup or indexing time does not permit replacing a required semantic query with text matching. Retry the same bounded workspace query at most two more times. If it still cannot resolve, record the operation and result as unresolved.
5. Read the complete project-owned callable unit at every resolved location.
6. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
7. If the correct LSP operation against the actual symbol is demonstrably partial for a relationship LSP does not model or expose, record the operation, result, and missing relationship. Then use an exact text search only within the already identified owning file or module to locate candidates. Read every candidate and verify its semantics against code and LSP. Text matches are candidate locations, not relationship evidence, and must not expand the search boundary or replace the initial LSP query.
8. Use Glob, generated context, architecture documents, and runtime evidence to locate dynamic registrations, configuration or string edges, macros, documentation, and external boundaries that LSP does not model.

## Evidence

- Record each resolved relationship and whether it came from LSP, runtime evidence, verified bounded source fallback, an external boundary, or a generated boundary.
- When an empty LSP result contradicts a direct call in the code, another LSP result, or runtime evidence, treat the relationship as unresolved. Record the contradiction and use exact fallback evidence.
- If LSP is unavailable or cannot resolve a required project-owned relationship, record that limitation and leave the relationship unresolved.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.
