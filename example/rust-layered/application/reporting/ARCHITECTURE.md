# Module Architecture: application-reporting

Status: draft
Owner: architect

## Scope

`application-reporting` owns application-facing reporting helper behavior.

## Boundary

- Layer: `application`
- Path: `application/reporting`
- Depends on `domain-accounts` and `domain-orders`.
- May depend on `domain-*` and `foundation-*` crates.

## Behavior

- Identifies itself as the `application::reporting` module.
- Provides deterministic resource keys for report view identifiers.
- Provides small normalization and description helpers for reporting resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define report view resource naming behavior.
- `normalize` and `describe` provide simple application operation helpers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Reporting key changes can affect durable reporting contracts.
- Application modules must not push reporting concerns down into domain modules.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
