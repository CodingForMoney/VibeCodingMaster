# Module Architecture: domain-accounts

Status: draft
Owner: architect

## Scope

`domain-accounts` owns account record naming and account-domain helper behavior.

## Boundary

- Layer: `domain`
- Path: `domain/accounts`
- Depends on `foundation-config` and `foundation-identity`.
- Must not depend on `application-*` crates.

## Behavior

- Identifies itself as the `domain::accounts` module.
- Provides deterministic resource keys for account record identifiers.
- Provides small normalization and description helpers for account resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define account resource naming behavior.
- `normalize` and `describe` provide simple operation helpers for higher application modules.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Account key changes can affect API and reporting behavior.
- Domain behavior must stay independent of application orchestration.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
