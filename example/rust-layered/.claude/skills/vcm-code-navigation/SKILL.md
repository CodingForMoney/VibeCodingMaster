---
name: vcm-code-navigation
description: Use when Architect must resolve code symbols, references, implementations, call hierarchies, or bounded dependency paths.
---

# VCM Code Navigation Skill

## Purpose

Use this skill when Architect must establish symbol definitions, implementations, references, callers, callees, or a bounded behavior path from current-worktree evidence.

## Navigation Order

1. Define the affected feature or module boundary and locate entry symbols with `.ai/generated/module-index.json` and `.ai/generated/public-surface.json` when available.
2. Locate each definition with an exact source-text search for its declaration form in the project language, such as `fn name`, `struct Name`, `trait Name`, `impl Trait for`, `class Name`, or `def name`. Read the complete declaration.
3. Find references with exact searches over the whole project source tree, excluding only build output, dependency, and generated directories. Search every spelling that can reach the symbol: direct calls, method calls, path-qualified uses, imports and re-exports, renaming imports and aliases, macro invocations, and string or configuration names used for dispatch or registration.
4. Treat each search as symbol-name evidence, not semantic evidence. An accessor, backing field, trait declaration, implementation method, wrapper, and alias are separate symbols; search each one. For a trait or interface item, search its implementations and every call through the trait, generic bound, or dynamic dispatch.
5. Read the complete project-owned callable unit at every match and classify the match as a relationship, a same-name unrelated symbol, a comment, or a test. Common names such as `new`, `get`, or `run` need the enclosing type or module to classify each match.
6. Expand one project-owned dependency hop at a time until the required behavior path has no unresolved symbol.
7. Use Glob, generated context, architecture documents, and runtime evidence to locate dynamic registrations, configuration or string edges, macros, documentation, and external boundaries.

## Completeness

- A relationship set is complete only when every search that could reach it was run and every match was read and classified.
- Search results cannot see identifiers produced by macros or code generation, code excluded by configuration such as disabled features or platform conditions, or calls through values whose concrete type is decided at runtime. When one of these can reach the symbol, read the generator, configuration, or dispatch site and record the limitation.
- When a match cannot be classified from the code, record the relationship as unresolved instead of assuming either answer.

## Evidence

- Record each relationship with its source: the exact search pattern and scope with every match dispositioned, runtime evidence, an external boundary, or a generated boundary.
- If an expected relationship is missing from a search that should reach it, recheck the spellings and scope before concluding the relationship is absent.
- Generated indexes and architecture docs locate likely code; reading current-worktree implementation establishes behavior.

## Context Boundary

Do not dump a whole-repository or unrestricted multi-hop graph into context. Keep the current symbol and its direct relationships, then expand deliberately within the affected feature or module boundary.
