# Codex Bridge Integration

## Purpose

VCM can run its normal Claude Code role sessions against Codex subscription
models through a user-managed Codex Bridge process. VCM manages the Claude Code
child process and session lifecycle. Codex Bridge owns the Anthropic-compatible
HTTP boundary and reads the existing Codex login.

VCM does not start Codex Bridge, refresh Codex OAuth credentials, or modify
`~/.claude/settings.json`.

## Runtime Contract

VCM probes these endpoints in order:

```text
http://127.0.0.1:3456
http://host.docker.internal:3456
```

For each endpoint, the backend performs:

1. unauthenticated `GET /health` and requires `service: codex-bridge`;
2. authenticated `GET /auth/status` and requires `state: ready`;
3. authenticated `GET /v1/models` and records the returned model catalog.

The frontend never calls Codex Bridge directly. The backend distinguishes an
unreachable Bridge, an invalid Bridge API key, unavailable Codex credentials,
an invalid response, and an empty model catalog.

Codex Bridge must be reachable from the VCM backend. A Bridge running on the
host for a DevContainer normally needs:

```bash
codex-bridge serve --host 0.0.0.0 --port 3456
```

## Global Settings

The global setting is stored under `codexBridge` in `~/.vcm/settings.json`:

```json
{
  "codexBridge": {
    "version": 1,
    "enabled": true,
    "apiKey": "..."
  }
}
```

The API key is write-only in the frontend contract and the settings file is
owner-readable only. The settings API is:

```text
GET  /api/settings/codex-bridge
PUT  /api/settings/codex-bridge
POST /api/settings/codex-bridge/check
```

## Model Selection

VCM does not hard-code a Bridge model. Every model returned by `/v1/models` is
added to Session controls with a namespaced value:

```text
codex-bridge:<model-id>
```

The namespace distinguishes Bridge sessions from native Claude sessions while
the actual model ID is sent unchanged to Codex Bridge. Starting a model that is
no longer in the current catalog fails before process creation.

## Claude Code Launch

Only a namespaced Codex Bridge model receives the Bridge launch profile:

```text
ANTHROPIC_BASE_URL=<identified Bridge endpoint>
ANTHROPIC_API_BASE_URL=<identified Bridge endpoint>
CLAUDE_AGENT_API_BASE_URL=<identified Bridge endpoint>
ANTHROPIC_MODEL=<selected model id>
ANTHROPIC_SMALL_FAST_MODEL=<selected model id>
CODEX_BRIDGE_CLAUDE_MODEL=<selected model id>
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
CLAUDE_CONFIG_DIR=~/.vcm/claude/codex-bridge
```

The child receives a session-only `apiKeyHelper` through `--settings`. The key
is not placed in the command, terminal output, or child environment. The Claude
adapter omits native `--model` for Bridge sessions because the selected model is
provided by the isolated environment.

VCM retains the Codex API context contract of `258400` tokens and proactive
compaction at `90%`. These values are independent of the transport process.

Native Claude launches receive no Bridge settings. VCM removes inherited local
Bridge takeover variables from native children so native Claude authentication
and model selection remain unchanged.

## Session Rules

- Start, Resume, Restart, one-click launch, Translator, and Harness Engineer use
  the same centralized Session launch path.
- Resume must remain on the recorded provider.
- Restart is required to switch between native Claude and Codex Bridge.
- A Bridge session requires its recorded isolated `CLAUDE_CONFIG_DIR`.
- Disabling Bridge blocks future Bridge Start, Resume, and Restart operations;
  it does not terminate a running process.
- Codex Bridge usage remains excluded from native Claude OpenTelemetry task
  analytics.

## Verification

The automated suite covers Bridge identity and auth checks, dynamic model
discovery, key redaction, container endpoint fallback, isolated launch settings,
native launch cleanup, provider switching, Resume/Restart, all seven role paths,
and one-click launch context settings.

Manual verification should confirm:

1. `codex-bridge status` and `codex-bridge doctor` succeed on the host;
2. VCM reports the connection as `available`;
3. the Session model list matches `/v1/models`;
4. a Bridge model completes a Claude Code turn and Hooks remain active;
5. a native Claude Restart contains no Bridge environment or settings.
