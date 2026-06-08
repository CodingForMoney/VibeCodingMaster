# Module Architecture: foundation-identity

Status: draft
Owner: architect

## Scope

`foundation-identity` owns low-level identity subject naming helpers.

## Boundary

- Layer: `foundation`
- Path: `foundation/identity`
- No workspace dependencies are allowed.
- Must not depend on `domain-*` or `application-*` crates.

## Behavior

- Identifies itself as the `foundation::identity` module.
- Provides deterministic resource keys for identity subject identifiers.
- Provides small normalization and description helpers for identity resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define identity resource naming behavior.
- `normalize` and `describe` provide simple operation helpers used by higher layers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Identity naming changes can affect domain records that reference subjects.
- Adding dependencies here would weaken the foundation layer boundary.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
