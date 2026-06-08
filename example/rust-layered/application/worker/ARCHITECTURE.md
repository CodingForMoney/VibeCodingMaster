# Module Architecture: application-worker

Status: draft
Owner: architect

## Scope

`application-worker` owns application-facing worker helper behavior.

## Boundary

- Layer: `application`
- Path: `application/worker`
- Depends on `domain-orders` and `foundation-telemetry`.
- May depend on `domain-*` and `foundation-*` crates.

## Behavior

- Identifies itself as the `application::worker` module.
- Provides deterministic resource keys for worker job identifiers.
- Provides small normalization and description helpers for worker resources.

## Important Public Surface

- `module_name` and `module_summary` expose stable crate identity.
- `default_resource` and `resource_key` define worker job resource naming behavior.
- `normalize` and `describe` provide simple application operation helpers.
- `layer_name`, `accepts_resource`, and `priority` are crate-internal helpers, not module-to-module public API.

The complete public function index belongs in `.ai/generated/public-surface.json`.

## Risks

- Worker key changes can affect background job contracts.
- Worker behavior must keep telemetry usage as an application concern, not a domain requirement.

## Update Triggers

Update this file when module behavior, dependencies, public surface meaning, or boundary rules change.
