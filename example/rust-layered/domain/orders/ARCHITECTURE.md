# Module Architecture: domain-orders

Status: draft
Owner: architect

## Scope

`domain-orders` owns order record naming and order-domain helper behavior.

## Boundary

- Layer: `domain`
- Path: `domain/orders`
- Depends on `domain-catalog` and `foundation-identity`.
- Must not depend on `application-*` crates.

## Behavior

- Identifies itself as the `domain::orders` module.
- Provides deterministic resource keys for order record identifiers.
- Provides small normalization and description helpers for order resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define order resource naming behavior.
- `normalize` and `describe` provide simple operation helpers for higher application modules.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Order key changes can affect reporting and worker behavior.
- Same-layer domain dependencies must stay intentional and acyclic.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
