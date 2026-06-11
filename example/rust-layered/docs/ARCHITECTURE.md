# Architecture

Status: draft
Owner: architect

## Overview

This project is a Rust workspace example for testing VCM harness behavior on layered Rust projects. It has three architecture layers:

- `foundation`: low-level reusable platform crates
- `domain`: business-domain crates
- `application`: entry/application-facing crates

`docs/ARCHITECTURE.md` is the project-level module overview. It records layers, modules, module responsibilities, module relationships, dependency direction, and project-wide architecture constraints.

Module-level detailed design belongs in each module's `ARCHITECTURE.md`. Complete machine-readable indexes live under `.ai/generated/`.

In this example, a module is a workspace crate.

## Module Overview

| Layer | Module | Path | Responsibility | Detail Doc |
| --- | --- | --- | --- | --- |
| `foundation` | `foundation-config` | `foundation/config` | Configuration identity and resource naming helpers. | `foundation/config/ARCHITECTURE.md` |
| `foundation` | `foundation-identity` | `foundation/identity` | Identity subject naming helpers. | `foundation/identity/ARCHITECTURE.md` |
| `foundation` | `foundation-telemetry` | `foundation/telemetry` | Telemetry event naming helpers. | `foundation/telemetry/ARCHITECTURE.md` |
| `domain` | `domain-accounts` | `domain/accounts` | Account record naming and account-domain helper behavior. | `domain/accounts/ARCHITECTURE.md` |
| `domain` | `domain-catalog` | `domain/catalog` | Catalog entry naming and catalog-domain helper behavior. | `domain/catalog/ARCHITECTURE.md` |
| `domain` | `domain-orders` | `domain/orders` | Order record naming and order-domain helper behavior. | `domain/orders/ARCHITECTURE.md` |
| `application` | `application-api` | `application/api` | Application-facing API helper behavior. | `application/api/ARCHITECTURE.md` |
| `application` | `application-reporting` | `application/reporting` | Application-facing reporting helper behavior. | `application/reporting/ARCHITECTURE.md` |
| `application` | `application-worker` | `application/worker` | Application-facing worker helper behavior. | `application/worker/ARCHITECTURE.md` |

## Dependency Direction

```text
application -> domain -> foundation
```

Rules:

- `foundation` crates must not depend on `domain-*` or `application-*` crates.
- `domain` crates must not depend on `application-*` crates.
- `application` crates may depend on `domain` and `foundation` crates.
- Do not add external dependencies unless explicitly approved.

## Module Detail Docs

Each module-level `ARCHITECTURE.md` owns:

- module boundary and allowed dependencies
- module behavior and non-goals
- important public surface explanations
- module-specific risks
- module-specific update triggers

## Public Surface

The public surface for this example is crate-external Rust API.

Root architecture docs explain public surface ownership and important policy only. Module-level architecture docs explain important public surface meaning. The complete machine-readable public surface belongs in `.ai/generated/public-surface.json`, not in prose architecture docs.

`pub(crate)`, `pub(super)`, `pub(in ...)`, and private module internals are not module-to-module public API.

## Generated Architecture Context

- `.ai/generated/module-index.json`: workspace module index generated from `cargo metadata`, with layer inferred from module path.
- `.ai/generated/public-surface.json`: complete crate-external public surface machine index.

## Security And Data Rules

- The project has no network, storage, secrets, auth, or unsafe code requirements.
- Do not add secrets, credentials, generated vendor code, or external service calls.
- Do not introduce `unsafe` without explicit approval and architecture review.

## Risks

- Layer dependency drift can undermine the example's purpose.
- Public API extraction can become misleading if generated context is stale.
- Repeated function names across crates are intentional and should be qualified by crate/file in generated context.

## Docs Update Triggers

Update this file when changing:

- layer responsibilities
- crate membership by layer
- dependency direction
- module detail doc paths
- public surface ownership policy
- security/data rules
- generated context ownership assumptions
