# Module Architecture: foundation-telemetry

Status: draft
Owner: architect

## Scope

`foundation-telemetry` owns low-level telemetry event naming helpers.

## Boundary

- Layer: `foundation`
- Path: `foundation/telemetry`
- No workspace dependencies are allowed.
- Must not depend on `domain-*` or `application-*` crates.

## Behavior

- Identifies itself as the `foundation::telemetry` module.
- Provides deterministic resource keys for telemetry event identifiers.
- Provides small normalization and description helpers for telemetry resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define telemetry resource naming behavior.
- `normalize` and `describe` provide simple operation helpers used by higher layers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Telemetry naming changes can affect application worker instrumentation.
- Adding dependencies here would weaken the foundation layer boundary.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
