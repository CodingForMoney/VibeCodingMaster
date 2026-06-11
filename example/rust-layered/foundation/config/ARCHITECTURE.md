# Module Architecture: foundation-config

Status: draft
Owner: architect

## Scope

`foundation-config` owns low-level configuration identity and resource naming helpers.

## Boundary

- Layer: `foundation`
- Path: `foundation/config`
- No workspace dependencies are allowed.
- Must not depend on `domain-*` or `application-*` crates.

## Behavior

- Identifies itself as the `foundation::config` module.
- Provides deterministic resource keys for config profile identifiers.
- Provides small normalization and description helpers for config resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define config resource naming behavior.
- `normalize` and `describe` provide simple operation helpers used by higher layers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Config naming changes can affect any higher layer that stores or compares resource keys.
- Adding dependencies here would weaken the foundation layer boundary.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
