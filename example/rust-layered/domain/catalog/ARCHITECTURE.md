# Module Architecture: domain-catalog

Status: draft
Owner: architect

## Scope

`domain-catalog` owns catalog entry naming and catalog-domain helper behavior.

## Boundary

- Layer: `domain`
- Path: `domain/catalog`
- Depends on `foundation-config`.
- Must not depend on `application-*` crates.

## Behavior

- Identifies itself as the `domain::catalog` module.
- Provides deterministic resource keys for catalog entry identifiers.
- Provides small normalization and description helpers for catalog resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define catalog resource naming behavior.
- `normalize` and `describe` provide simple operation helpers for higher application modules and domain orders.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Catalog key changes can affect API and order behavior.
- Domain behavior must stay independent of application orchestration.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
