---
name: vcm-code-navigation
description: Use when Architect, Coder, or Reviewer must resolve code symbols, references, implementations, call hierarchies, or bounded dependency paths.
---

# VCM Code Navigation Skill

## Purpose

Use this skill when Architect, Coder, or Reviewer must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Search Selection

- Use `.ai/generated/module-index.json`, `.ai/generated/public-surface.json`, and Glob to locate modules and files.
- Use the VCM shared LSP tools for project-owned symbol definitions, implementations, references, callers, callees, type relationships, hover information, and call hierarchy.
- Use Read to inspect each resolved callable unit or source site in full.
- Use Grep only for exact text LSP does not model: comments, documentation, configuration keys, string literals, diagnostics, and `VCM:CODE` markers.
- Use generated context, architecture documents, runtime evidence, and exact non-semantic text search for dynamic registrations, configuration-driven edges, macros, generated code, and external boundaries.

## Navigation Order

1. Define the affected feature or module boundary and locate its project files.
2. Call shared LSP `status`; if the language is starting or indexing, wait by retrying the semantic query. Do not substitute another search method.
3. Resolve each project-owned relationship with the matching shared LSP operation.
4. Read the complete project-owned callable unit at every resolved location.
5. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
6. Resolve non-LSP boundaries with the specific generated, runtime, configuration, documentation, or exact-text evidence they require.

## Evidence

- Record each resolved relationship and whether it came from shared LSP, runtime evidence, an external boundary, or a generated boundary.
- A shared LSP result of `unresolved` is not evidence that a symbol or relationship is absent.
- When an empty LSP result contradicts code or runtime evidence, record the contradiction and leave the semantic relationship unresolved.
- If shared LSP ultimately cannot resolve a required project-owned relationship, record the operation and limitation. Grep, comments, memory, and inference cannot replace that semantic evidence.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.
