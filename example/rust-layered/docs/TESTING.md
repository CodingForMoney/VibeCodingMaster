# Testing

Status: draft
Owner: reviewer

## Purpose

`docs/TESTING.md` is the durable testing source of truth for this Rust workspace. Reviewer owns validation strategy, validation commands, validation levels, and known testing gaps.

## Validation Levels

| Level | Purpose | Example commands |
| --- | --- | --- |
| L0 fast checks | Formatting and compilation checks that are cheap enough to run often. | `cargo fmt --check`, `cargo check --workspace` |
| L1 coder unit checks | Colocated unit tests for changed crate internals. | `cargo test -p foundation-config --lib` |
| L2 module / integration checks | Crate-level unit and integration validation for affected modules. | `cargo test -p foundation-config` |
| L3 smoke E2E checks | Application-level smoke flows. | Not configured |
| L4 full regression / release checks | Broad release confidence. | Not configured |

## Validation Commands

### Native Project Checks

Use Rust-native commands instead of VCM validation wrappers:

```bash
cargo fmt --check
cargo check --workspace
cargo test -p <crate> --lib
cargo test -p <crate>
cargo test --workspace
```

Choose the smallest command that gives the needed confidence for the role and task scope. Use workspace-level checks when the change is broad or dependency boundaries are uncertain.

## Rust Test Placement

- Unit tests live colocated with source under `src/` using `#[cfg(test)] mod tests`.
- Coder may add or update colocated unit tests while implementing code and should run affected crate unit tests with `cargo test -p <crate> --lib`.
- Reviewer reviews unit test adequacy and may add, remove, or adjust unit test cases.
- Integration tests live under each crate's `tests/` directory and exercise public crate behavior.
- Reviewer owns integration test design and maintenance.
- This project does not use `test-map.json`; changed files map to crates through `.ai/generated/module-index.json`.

### Generated Context

Run:

```bash
.ai/tools/generate-module-index --check
.ai/tools/generate-public-surface --check
```

Checks:

- `module-index.json` matches current Cargo metadata, crate manifests, source files, and integration test files.
- `public-surface.json` matches crate-external Rust `pub fn`, `pub struct`, `pub enum`, and `pub trait` items found through the module index.

Regenerate without `--check` after module, manifest, source-file, test-file, or crate-external public API changes.

## Test Expectations

- Rust changes should pass `cargo fmt --check` and `cargo check --workspace`.
- L1 coder unit checks should use `cargo test -p <crate> --lib` for changed crates.
- L2 module validation should use `cargo test -p <crate>` for affected crates.
- Public API changes should keep `.ai/generated/public-surface.json` aligned.
- Validation failures should be reported with command, expected behavior, observed behavior, reproduction steps, and skipped checks.

## Known Testing Gaps

- Each crate has colocated unit coverage for `module_summary()` and one basic integration test; broader behavior coverage is still minimal.
- `module-index.json` and `public-surface.json` are generated context artifacts, not validation wrappers.
- No L3/L4 smoke or release validation is configured.

Record durable unresolved testing gaps in `docs/known-issues.md` when they must survive task cleanup.
