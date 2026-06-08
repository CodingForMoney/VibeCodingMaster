# Module Architecture: application-api

Status: draft
Owner: architect

## Scope

`application-api` owns application-facing API helper behavior.

## Boundary

- Layer: `application`
- Path: `application/api`
- Depends on `domain-accounts` and `domain-catalog`.
- May depend on `domain-*` and `foundation-*` crates.

## Behavior

- Identifies itself as the `application::api` module.
- Provides deterministic resource keys for API endpoint identifiers.
- Provides small normalization and description helpers for API resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define API endpoint resource naming behavior.
- `normalize` and `describe` provide simple application operation helpers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- API resource naming changes can affect user-facing route or contract examples.
- Application modules must not push orchestration concerns down into domain modules.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
