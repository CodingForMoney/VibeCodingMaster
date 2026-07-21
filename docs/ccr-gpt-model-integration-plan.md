# CCR GPT Model Integration Plan

Last updated: 2026-07-21

Status: implemented on the `v07` branch.

## 1. Goal

Allow VCM-managed Claude Code sessions running locally or inside a DevContainer
to use the supported GPT model exposed by a host-running Claude Code Router
(CCR).

The user installs, authenticates, configures, starts, and updates CCR on the
host. VCM does not manage the CCR process. VCM provides:

- a global CCR integration switch
- an authenticated connectivity and capability check performed by the VCM
  backend from its current runtime
- availability detection for the supported CCR model in existing model
  selectors
- per-session environment injection when a CCR model is selected
- explicit launch errors when the selected CCR model is unavailable

VCM continues to launch and supervise every Claude Code process through its
existing `node-pty` runtime. Session, Hook, Round, retry, translation, Harness
Engineer, Gate Reviewer, and orchestration behavior remain owned by VCM.

## 2. Deployment Boundary

```text
Host
  CCR configuration and ChatGPT/Codex login
  CCR model gateway (container-reachable host and port)
            |
            | Anthropic-compatible HTTP
            v
DevContainer
  VCM backend
    -> checks CCR and verifies the supported model
    -> launches `claude` with a session-scoped CCR environment
  Claude Code
    -> sends model requests to CCR
```

VCM must not:

- install, configure, start, stop, restart, or update CCR
- invoke host-side `ccr`, `ccr-app`, or a CCR-managed Claude profile
- read or store the user's ChatGPT/Codex account credentials
- connect to the CCR management UI or its management API
- change global Claude Code settings or the container shell environment
- silently replace an unavailable CCR model with Claude or another model

VCM connects only to CCR's model gateway. CCR remains the source of truth for
provider authentication, upstream model configuration, request conversion,
and ChatGPT subscription usage.

## 3. Runtime Endpoint Contract

VCM checks these fixed endpoints in order:

```text
http://127.0.0.1:3456
http://host.docker.internal:3456
```

The first endpoint supports VCM running directly on the CCR host. The second
supports VCM running inside a DevContainer. VCM verifies the CCR identity before
selecting an endpoint, then uses that same endpoint for model discovery and GPT
session launches.

CCR must listen on an interface reachable from the DevContainer. For the
VCM integration contract this means:

```json
{
  "HOST": "0.0.0.0",
  "PORT": 3456,
  "APIKEY": "a-user-selected-secret"
}
```

CCR forces a loopback-only listener when no API key is configured. Therefore,
a host CCR exposed to a container must use an API key. VCM uses that API key
only to authenticate to the local CCR gateway; it is not an OpenAI or ChatGPT
credential.

Docker Desktop supplies `host.docker.internal`. Linux DevContainer setups must
map that name to the host gateway. VCM does not scan arbitrary hosts or ports.

The CCR management UI port is outside this contract. VCM must not assume that
the management UI and model gateway use the same port or authentication.

## 4. Global Settings

CCR integration is a VCM global preference stored in `~/.vcm/settings.json`.
It is not indexed by repository, task, or role.

Persist one top-level settings object:

```ts
interface CcrIntegrationSettingsState {
  version: 1;
  enabled: boolean;
  apiKey: string;
}
```

The Settings sidebar adds:

- a `CCR GPT models` switch
- CCR API key as a password field
- a `Save API key` command
- connection state
- a `Check connection` command

The API key is write-only in frontend API responses. Responses expose only
`apiKeyConfigured: boolean`. An omitted API key during an update preserves the
saved value; an explicit clear operation removes it and disables CCR
integration. Error messages and logs must redact the key. The settings file
must be written with owner-only `0600` permissions.

The API key must be saved before the switch can be enabled. After a successful
save, the password field is cleared and the UI shows only that a key is
configured. The switch and `Check connection` remain disabled until then.
Enabling without a saved key is rejected and leaves the switch off.

After a key is configured, enabling the switch records the user's intent and
immediately asks the backend to check CCR. A failed check leaves the integration
enabled but unavailable so that a later check can recover without losing the
configuration. The supported CCR model remains unavailable until a check
succeeds.

## 5. Backend CCR Adapter

Add a backend adapter responsible only for the CCR HTTP boundary. The frontend
must never call CCR directly.

The check runs:

1. when CCR integration is enabled
2. when the API key changes
3. when the user requests `Check connection`
4. during VCM startup when the saved switch is enabled
5. before starting, resuming, or restarting a session configured with a CCR
   model

The adapter performs:

1. `GET /` to verify that the endpoint identifies itself as a CCR gateway
2. authenticated `GET /v1/models` with a Claude Code user agent
3. schema validation of the returned model list
4. confirmation that `Codex API/gpt-5.6-sol` is present

The check does not submit an inference request and does not consume model
quota. It returns one of these runtime states:

```ts
type CcrConnectionState =
  | "disabled"
  | "checking"
  | "available"
  | "unreachable"
  | "unauthorized"
  | "not-ccr"
  | "invalid-response";
```

The runtime result includes whether `Codex API/gpt-5.6-sol` is available,
`checkedAt`, and a precise redacted error. Runtime state is held in backend
memory and is not written to settings.

Checks use a short timeout, one shared in-flight request, and a short cache
lifetime so a one-click launch does not perform the same request once per role.
There is no component-owned polling interval. A pre-launch check may use the
fresh cached result; an expired result must be refreshed before process
creation.

## 6. Model Identity And Discovery

The current `SessionModel` type contains only static Claude aliases. CCR models
must be namespaced so they cannot collide with Claude aliases or be mistaken
for native Claude models.

Keep native Claude values unchanged and namespace only CCR models:

```text
default
opus
ccr:Codex API/gpt-5.6-sol
```

Existing persisted Claude values (`default`, `fable`, `opus`, and `sonnet`)
remain valid without migration. The CCR prefix is sufficient to distinguish
the new launch path.

The first implementation supports only `Codex API/gpt-5.6-sol`, displayed as
`GPT-5.6 Sol (CCR)`. The authenticated CCR `/v1/models` response confirms
whether that exact model is currently available. Other CCR models are ignored
and are not added to model selectors.

When available, the backend appends this model to the options returned to all
controls. Controls must not infer CCR availability independently. This
includes:

- each VCM role toolbar
- Gate Reviewer when enabled
- Translator and Harness Engineer controls
- Harness Bootstrap controls
- saved launch-template controls and one-click launch

A saved `ccr:Codex API/gpt-5.6-sol` selection remains visible as unavailable
when CCR is disabled, down, or no longer reports that model. VCM must not erase
the selection or normalize it to `default`.

## 7. Claude Code Launch Environment

Native Claude selections keep the current launch behavior and receive no CCR
environment variables.

For a CCR selection, VCM launches the normal container `claude` executable and
injects these variables only into that child process:

```text
ANTHROPIC_BASE_URL=<identified CCR endpoint>
ANTHROPIC_API_BASE_URL=<identified CCR endpoint>
CLAUDE_AGENT_API_BASE_URL=<identified CCR endpoint>
ANTHROPIC_AUTH_TOKEN=<unset>
ANTHROPIC_API_KEY=<unset>
ANTHROPIC_MODEL=Codex API/gpt-5.6-sol
CCR_CLAUDE_CODE_MODEL=Codex API/gpt-5.6-sol
CODEXL_CLAUDE_CODE_MODEL=Codex API/gpt-5.6-sol
ANTHROPIC_SMALL_FAST_MODEL=Codex API/gpt-5.6-sol
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
NO_PROXY=<existing entries plus identified CCR host>
```

The selected CCR model is supplied through the environment. The Claude adapter
must not also append the native `--model` argument for a CCR selection. Native
Claude selections continue to use `--model` exactly as they do now.

CCR-managed Claude Code profiles authenticate through the `apiKeyHelper` in
Claude settings. VCM therefore removes inherited Anthropic token and API-key
variables from CCR-backed child processes so they cannot override that helper.
The API key saved in VCM is used only for CCR connection and model discovery.
Native Claude sessions do not receive these removals and retain their existing
authentication behavior.

The API key must never appear in the display command, terminal output, session
record, event stream, diagnostics, or process error text. Session records and
launch templates persist only the namespaced model identifier.

The same launch-environment builder must be used by every VCM-owned Claude
session path. Adding CCR logic independently to role, Translator, Harness
Engineer, or Bootstrap launch code is not acceptable.

## 8. Session And Setting Behavior

- `Start`, `Resume`, and `Restart` use the model currently selected in that
  session panel.
- Resume may use a different selected model, matching current VCM behavior.
- One-click launch validates CCR once and applies the configured model to each
  role from the saved launch template.
- Disabling CCR affects future Start, Resume, and Restart operations. It does
  not mutate the environment of an already-running process.
- A running CCR-backed session remains supervised by the existing process,
  terminal, Hook, retry, Session, Turn, and Round logic.
- CCR transport or upstream failures surface through the existing Claude Code
  failure path. VCM never falls back to a native Claude model.
- The existing effort and permission controls remain in force. CCR integration
  does not add a second Session implementation or a separate role type.

## 9. API Surface

Add a global CCR settings/status API rather than mixing the secret and volatile
status into project runtime state:

```text
GET  /api/settings/ccr
PUT  /api/settings/ccr
POST /api/settings/ccr/check
```

`GET` returns safe settings, runtime status, and the supported CCR model option
when available. `PUT` updates the global switch or write-only API key and then
refreshes status when required. `POST /check` forces a backend check.

Session start requests continue to carry one `model` selection. Backend
validation resolves its namespace, verifies an available CCR model when
needed, and produces the command plus child environment. The frontend only
renders available options and submits the selected value.

## 10. Failure Behavior

VCM must reject CCR-backed process creation with a precise error in these
cases:

| Condition | Required result |
| --- | --- |
| Integration disabled | Report that CCR GPT models are disabled. |
| Host or port unreachable | Include both supported runtime URLs and their connection errors. |
| Request timeout | Report the endpoint and timeout. |
| HTTP 401/403 | Report that the CCR API key was rejected. |
| Endpoint is not CCR | Report that the URL did not identify a CCR gateway. |
| Invalid model response | Report the invalid `/v1/models` response without dumping secrets. |
| `gpt-5.6-sol` missing | Name the unavailable model and require a CCR configuration check. |

No failure may silently change the saved model, start Claude with `default`,
or launch a session without the CCR environment.

## 11. Implementation Areas

### Shared contracts

- extend app settings contracts with safe CCR settings/status types
- extend `SessionModel` with the namespaced `gpt-5.6-sol` value while retaining
  existing Claude values
- define backend-owned model-option contracts

### Backend

- persist and normalize global CCR settings in `app-settings-service`
- add the CCR HTTP adapter and settings/status routes
- compose one shared CCR connection service in `server.ts`
- extend `claude-adapter` to distinguish native and CCR launch models
- centralize CCR child-environment construction in the Session launch path
- validate CCR availability for all Start, Resume, Restart, Bootstrap, and
  one-click launch paths

### Frontend

- add the global CCR switch, API-key input, status, and manual check to Settings
- load backend-owned model options
- pass model options into shared session controls instead of reading a static
  constant inside each component
- preserve unavailable saved CCR selections and show why they cannot launch

## 12. Tests

### Unit tests

- settings defaults, normalization, persistence, API-key preservation, clear,
  and response redaction
- fixed CCR endpoint handling and `NO_PROXY` merging
- gateway identity, authentication, timeout, invalid response, empty list, and
  successful model discovery
- CCR model parsing and unchanged native Claude-model normalization
- native Claude command generation remains unchanged
- CCR launch omits native `--model` and injects the complete environment
- no secret is present in command display, records, logs, or returned errors
- disabled/unavailable/missing-model launches are rejected without fallback

### Backend E2E tests

Use a mock CCR HTTP server plus the existing mock Claude Code runtime to cover:

1. enable CCR, detect `gpt-5.6-sol`, select it, and start a role
2. verify the mock Claude process receives the CCR environment
3. start multiple roles with one-click launch and verify one shared connection
   check is used
4. resume and restart a CCR-backed session
5. verify native Claude sessions receive no CCR environment
6. stop CCR and verify a new launch is blocked with a precise error
7. reject an invalid API key and a missing `gpt-5.6-sol` model
8. verify Hooks, Session state, Round state, retry, and close-task behavior are
   unchanged for a CCR-backed role
9. start Translator, Harness Engineer, Gate Reviewer, and Harness Bootstrap
   through their existing session paths with a CCR model

### Manual DevContainer smoke test

1. start and authenticate CCR on the host
2. confirm `GET /v1/models` succeeds from inside the DevContainer
3. enable CCR in VCM and confirm `GPT-5.6 Sol (CCR)` appears
4. start one Claude Code role with `GPT-5.6 Sol (CCR)`
5. confirm CCR receives the request and the role's Hook/terminal lifecycle is
   normal
6. stop CCR and confirm VCM refuses a new GPT-backed launch without falling
   back

## 13. Delivery Order

1. shared model/settings contracts
2. backend CCR adapter, status cache, safe settings API, and tests
3. centralized session launch environment and launch validation
4. backend-owned frontend model controls and global Settings UI
5. launch-template, auxiliary-session, Bootstrap, and one-click coverage
6. backend E2E and DevContainer smoke verification
7. architecture, testing, and user documentation updates

## 14. Acceptance Criteria

- CCR is installed and run only by the user on the host.
- VCM can verify the CCR gateway from inside its DevContainer without making an
  inference request.
- Enabling CCR exposes `GPT-5.6 Sol (CCR)` only when CCR reports
  `Codex API/gpt-5.6-sol`.
- Selecting `GPT-5.6 Sol (CCR)` starts the normal VCM-managed Claude Code
  process with only session-scoped environment changes.
- Native Claude model launches remain unchanged.
- CCR credentials never appear in frontend responses, terminal commands,
  session records, or logs.
- An unavailable endpoint, rejected key, or missing model blocks the launch
  with an exact error and never falls back silently.
- All role and auxiliary Session lifecycles continue to use the existing VCM
  runtime and state-management paths.

## References

- [Claude Code Router repository](https://github.com/musistudio/claude-code-router)
- [CCR profile environment construction](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/profiles/service.ts)
- [CCR gateway model discovery](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/gateway/features/model-discovery.ts)
