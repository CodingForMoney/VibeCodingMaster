# Codex Translation Plan

## 1. Purpose

VCM currently has API-backed conversation translation for terminal output,
gateway messages, and user prompts. That mode is useful for short interactive
messages, but it does not have enough project context for high-quality
translation when terminology depends on the repository, prior task discussion,
or long documents.

Translation should use a long-lived Codex translation role instead of stateless
translation API calls where quality depends on context. The goal is to let one
Codex session build and reuse project-level translation context: terminology,
style, prior decisions, existing translated files, source-document structure,
and interactive conversation conventions.

The existing role-console translation panel should remain the main UI for
conversation translation. The backend source of translated text changes from an
API provider to Codex Translator.

## 2. Core Direction

Add a new Codex role:

```text
codex-translator
```

The role is responsible for both project-level file translation and task-level
conversation translation. It should:

- read the target source file and relevant project context
- maintain durable translation memory files
- translate directly into output files under `<baseRepoRoot>/.ai/vcm`
- record file metadata so unchanged files are not translated repeatedly
- support resume/retry after interruption
- produce a translation report with coverage and consistency checks
- translate short conversation items sent by VCM and return the translated text
  through Codex hook completion metadata

Codex Translator is not part of the Claude Code PM/architect/coder/reviewer
workflow. It is a project utility role, like Codex Reviewer in terminal shape,
but with different permissions, output paths, and task semantics.

## 3. Why Codex Session Translation

API translation has two weaknesses for long technical documents:

- Each call sees only a small slice of context unless VCM manually injects a
  large context block.
- Translation memory is usually implicit in the prompt, so terminology and
  project-specific meanings drift across calls.

Codex session translation improves this because:

- the session can inspect the whole repository and the whole source document
- Codex can keep a long conversation state and use its normal context
  compaction behavior
- durable memory files can preserve decisions across session compaction,
  restarts, and future translation jobs
- translation output can be written to files instead of returned through one
  very large API response

The product should not rely only on chat context. The Codex session is useful,
but durable translation memory is the source of truth for project-level
conventions.

## 4. Storage Layout

VCM must keep two translation lifecycles separate:

| Translation type | Purpose | Root | Lifecycle | Cleanup |
| --- | --- | --- | --- | --- |
| File translation | Project documents, whitepapers, specs, long-form artifacts | `<baseRepoRoot>/.ai/vcm/file-translations/` | Long-term project-local state | Survives task cleanup and worktree deletion |
| Conversation translation | Role console output, user prompt translation, gateway replies | `<taskRepoRoot>/.ai/vcm/translation/<task>/...` | Temporary task runtime cache | Removed with task runtime state |

File translation state is project-level, not task-level. It lives under the
connected base repository:

```text
<baseRepoRoot>/.ai/vcm/file-translations/
  index.json
  memory/
    glossary.md
    style-guide.md
    project-context.md
    decisions.md
  jobs/
    <translation-id>/
      request.json
      progress.json
      output.md
      report.md
      checkpoints/
```

This path is intentionally under `<baseRepoRoot>`, not `<taskRepoRoot>`, because
file translation is a project asset that should survive task cleanup. In
worktree-backed tasks, `<taskRepoRoot>` points at
`<baseRepoRoot>/.claude/worktrees/<task>` and may be deleted when the task is
closed. File translation must never be stored there.

The existing console translation cache remains separate:

```text
<taskRepoRoot>/.ai/vcm/translation/<task>/<role>/<session-id>.jsonl
```

Conversation translation request state, if persisted, must stay under the same
task runtime translation root, for example:

```text
<taskRepoRoot>/.ai/vcm/translation/<task>/codex-translator/
  requests/
    <translation-id>.json
  results/
    <translation-id>.json
```

This state is temporary. It exists only to coordinate in-flight requests,
retries, panel rendering, and debugging for the current task.

`file-translations/` must never be deleted by task cleanup. It is local VCM
state and is normally ignored by git through `.ai/vcm/`. If the user wants a
translated file committed to the project, VCM should provide an explicit export
or copy step.

Inline tasks are the only case where `<baseRepoRoot>` and `<taskRepoRoot>` are
the same directory. Even then, cleanup must remove only task-scoped paths such
as `.ai/vcm/translation/<task>/`, sessions, messages, orchestration, handoffs,
and task Codex review state. Cleanup must not remove
`.ai/vcm/file-translations/`.

Implementation rule: file translation services must resolve and persist through
the connected project base root. They must not use `getTaskRuntimeRepoRoot()` or
any task worktree root when computing file translation paths.

## 5. Translation Memory

Translation memory should be explicit files, not just model memory.

Recommended files:

- `memory/glossary.md`: approved translations for project terms, product names,
  protocol names, module names, acronyms, and phrases.
- `memory/style-guide.md`: tone, target language variant, formatting rules,
  how to handle headings, code identifiers, tables, examples, and citations.
- `memory/project-context.md`: durable project background useful for
  translation accuracy.
- `memory/decisions.md`: dated translation decisions and exceptions.

Codex Translator must read these files before each file translation job and may
use them for conversation translation. It may update them only when it discovers
a stable convention that should affect future translations. It must not store
transient task chatter, progress notes, or failed attempts in memory files.

Progress belongs in `jobs/<translation-id>/progress.json`; diagnostic notes
belong in `jobs/<translation-id>/report.md`.

## 6. File Index And De-duplication

`index.json` prevents duplicate translation and supports resume.

Suggested schema shape:

```json
{
  "version": 1,
  "updatedAt": "2026-06-14T00:00:00.000Z",
  "jobs": [
    {
      "id": "whitepaper-v0-8-zh-20260614-001",
      "sourcePath": "docs/whitepaper-v0.8.md",
      "baseRepoRoot": "/absolute/base/repo/root",
      "taskRepoRoot": null,
      "sourceHash": "sha256:...",
      "sourceBytes": 449958,
      "sourceMtimeMs": 1790000000000,
      "targetLanguage": "zh-CN",
      "translationProfile": "default-technical-whitepaper",
      "memoryHash": "sha256:...",
      "dedupeKey": "sha256:<sourceHash>|zh-CN|default-technical-whitepaper",
      "status": "completed",
      "codexSessionId": "...",
      "model": "gpt-5.5",
      "effort": "xhigh",
      "resultPath": ".ai/vcm/file-translations/jobs/whitepaper-v0-8-zh-20260614-001/output.md",
      "reportPath": ".ai/vcm/file-translations/jobs/whitepaper-v0-8-zh-20260614-001/report.md",
      "createdAt": "2026-06-14T00:00:00.000Z",
      "updatedAt": "2026-06-14T00:00:00.000Z",
      "completedAt": "2026-06-14T00:00:00.000Z"
    }
  ]
}
```

`sourcePath`, `resultPath`, and `reportPath` are relative to `<baseRepoRoot>`.
They are not relative to a task worktree.

De-duplication rules:

- If the same `dedupeKey` has a completed job, VCM should show the existing
  translation instead of starting a new one.
- If the source hash changed, VCM must create a new job.
- If the same file is translated from a task worktree, VCM should normalize the
  source path back to the base repo path when possible; the long-term job still
  belongs to `<baseRepoRoot>/.ai/vcm/file-translations/`.
- If only memory files changed, VCM should ask whether to reuse the old
  translation, re-run consistency review, or retranslate.
- Failed or interrupted jobs can be resumed when `progress.json` has enough
  section state.
- Force retranslate should create a new job id and preserve the old result.

## 7. Codex Translator Role

Codex Translator needs its own durable instructions, separate from Codex
Reviewer. Recommended harness path:

```text
<baseRepoRoot>/.ai/codex-translator/
  AGENTS.md
  config.toml
  .codex/
    config.toml
    hooks.json
```

The role should start from `.ai/codex-translator` so Codex loads the translator
`AGENTS.md`. It should reuse the existing Codex embedded terminal/session
management pattern:

- start/resume/restart/stop terminal controls
- model and effort selectors
- hook-based running/idle state
- persisted Codex session id
- long-lived terminal session for follow-up discussion

The role must not use Codex Reviewer prompts or permissions.

Codex Translator should have durable instructions for both modes:

- file translation: write long results to files and report coverage
- conversation translation: return only the requested translated text unless VCM
  explicitly asks for notes or diagnostics
- memory usage: respect glossary, style guide, and project context without
  adding task-local chatter to memory files

## 8. Permissions

Default permissions should be conservative:

- read: `<baseRepoRoot>`
- write: `<baseRepoRoot>/.ai/vcm/file-translations/`
- deny: secrets such as `**/*.env`
- network: disabled except normal Codex model access controlled by Codex CLI

Codex Translator should not edit production code, existing docs, role files, or
source documents by default. Exporting a translated file into the project tree
should be a separate explicit user action.

## 9. Hook Result Contract

VCM should use Codex hooks, not terminal text scraping, to track conversation
translation completion.

Observed Codex hook payload shape:

```text
UserPromptSubmit:
- session_id
- turn_id
- transcript_path
- cwd
- hook_event_name = UserPromptSubmit
- model
- permission_mode
- prompt

Stop:
- session_id
- turn_id
- transcript_path
- cwd
- hook_event_name = Stop
- model
- permission_mode
- stop_hook_active
- last_assistant_message
```

Output contract:

- `Stop.last_assistant_message` is the primary translated-text source for
  conversation translation.
- `transcript_path` is persisted as the debug and recovery source.
- The transcript JSONL can also be parsed for `event_msg.agent_message.message`
  or `task_complete.last_agent_message` when the stop hook did not deliver a
  usable `last_assistant_message`.
- VCM must not parse the embedded Codex terminal's raw PTY output. It contains
  ANSI control sequences and UI redraw text, so it is not a reliable data
  channel.

Trust constraint:

- Codex project-local `.codex/hooks.json` is loaded only for trusted project
  roots. `--dangerously-bypass-hook-trust` allows enabled hook commands to run
  without per-command review, but it does not make an untrusted directory load
  project-local hooks.
- VCM should run Codex Translator from the harness-managed, trusted project path
  and treat hook registration as part of harness setup.

## 10. File Translation Workflow

Recommended flow:

```text
User selects source file and target language
  -> VCM computes file metadata and source hash
  -> VCM checks file-translations/index.json
  -> if completed duplicate exists, show existing result
  -> else create translation job
  -> VCM starts or resumes Codex Translator
  -> VCM sends job prompt to Codex Translator
  -> Codex reads source, memory, and project context
  -> Codex writes output.md and progress.json
  -> Codex writes report.md
  -> VCM marks job completed / failed / interrupted
```

The translation prompt should tell Codex:

- do not print the whole translation to the terminal
- write the translated document directly to `output.md`
- preserve Markdown structure, code blocks, links, tables, heading hierarchy,
  front matter, and identifiers
- use glossary and style guide consistently
- update progress after each completed section
- write a final report with source coverage, skipped content, glossary updates,
  and QA findings

## 11. Conversation Translation Workflow

Conversation translation reuses the existing translation panel. The panel should
not know whether the translated text came from an API provider or from Codex.

Recommended flow:

```text
VCM filters translatable content
  -> VCM checks whether Codex Translator is currently translating
  -> if busy, queue the request
  -> if idle, send a compact translation prompt to Codex Translator
  -> Codex translates using AGENTS.md plus current session memory
  -> UserPromptSubmit hook marks translator busy
  -> Stop hook returns last_assistant_message
  -> VCM writes the translated text to the existing translation panel cache
  -> VCM starts the next queued request, if any
```

Prompt shape should stay minimal because the durable translation rules live in
`AGENTS.md` and memory files. VCM should send the source text, direction, target
language, and any immediate local context needed to avoid ambiguity. It should
not rebuild a large translation policy prompt for every item.

Concurrency rules:

- Allow only one in-flight Codex Translator request per task/session.
- Queue new conversation translation requests while the translator is running.
- Use hook state, not terminal silence, to decide whether the translator is
  busy.
- If Codex execution fails, VCM should expose retry / skip / fallback handling
  to the user.

Result handling:

- For normal conversation translation, the Codex response should be the
  translated text only.
- VCM stores that text in the existing temporary translation cache under
  `<taskRepoRoot>/.ai/vcm/translation/<task>/...`.
- VCM should keep the `session_id`, `turn_id`, `transcript_path`, source text
  hash, and timestamp with each request result for retry and debugging.
- For long or structured text that may exceed a comfortable assistant message,
  VCM should switch to the file-translation flow and ask Codex to write a result
  file instead.

## 12. File Translation Strategy

For files that fit comfortably in a large context window, Codex Translator
should read the whole source file before translating. That preserves global
context and improves terminology choices.

Output still should not be one huge terminal response. Codex should write the
target file directly and may translate section by section inside the same
session.

Suggested internal sequence:

1. Read source file and memory files.
2. Build a section map.
3. Identify or update glossary candidates.
4. Translate into `output.md` by section.
5. Update `progress.json` after each section.
6. Run a structure check against the source.
7. Run a terminology consistency check.
8. Write `report.md`.

This keeps the quality advantage of whole-file context without depending on one
single model response to return the entire translated file.

## 13. Progress And Resume

`progress.json` should include:

```json
{
  "status": "in_progress",
  "sourcePath": "docs/whitepaper-v0.8.md",
  "targetLanguage": "zh-CN",
  "sections": [
    {
      "id": "abstract",
      "heading": "Abstract",
      "sourceStartLine": 7,
      "sourceEndLine": 20,
      "status": "completed",
      "outputStartLine": 7,
      "outputEndLine": 22
    }
  ],
  "currentSectionId": "architecture",
  "lastUpdatedAt": "2026-06-14T00:00:00.000Z"
}
```

Resume behavior:

- If Codex session is still available, continue in the same session.
- If the terminal was stopped, resume the Codex session id when possible.
- If the session cannot resume, start a new Codex Translator session and reload
  memory plus `request.json`, `progress.json`, and partial `output.md`.
- Never overwrite a completed output unless the job is explicitly marked as
  force-retranslate.

## 14. UI Shape

Add a project-level file translation surface, not a task role gate.

Recommended UI:

- Sidebar group: `File Translation`
- Controls:
  - source file picker or path input
  - target language
  - translation profile
  - model
  - effort
  - `Translate`
  - `Resume`
  - `Open result`
  - `Force retranslate`
- Status:
  - current Codex Translator session
  - active job
  - completed sections
  - output path
  - report path

When a file translation job exists, the workspace should expose a `Codex
Translator` embedded terminal role so the user can discuss terminology, challenge
translation choices, or ask for focused revisions after the automated pass.

For conversation translation, keep the existing split translation panel. The
visible behavior should remain:

- source appears immediately
- status shows queued/translating/error/translated
- translated text replaces or accompanies the source according to the existing
  panel behavior
- retry operates on the temporary translation entry

The panel should not parse Codex terminal output. It receives translated entries
from the backend after the Codex `Stop` hook.

## 15. Backend Services

New backend pieces:

- `codex-translation-service`
  - create job
  - compute source hash
  - resolve base repo root and reject task-worktree output paths
  - load/update index
  - start/resume Codex Translator
  - send job prompt
  - queue and send conversation translation prompts
  - consume `Stop.last_assistant_message` for conversation translation results
  - monitor completion
- `codex-translation-routes`
  - list jobs
  - create job
  - get job status
  - read result/report
  - resume/retry/force retranslate
  - get conversation translation request status when needed for debugging
- translator hook service
  - same running/idle tracking pattern as Codex Reviewer
  - persist `session_id`, `turn_id`, `transcript_path`, and
    `last_assistant_message`
  - separate endpoint names, for example:

```text
POST /api/hooks/codex-translator
POST /api/hooks/codex-translator/stop
```

The existing Codex Reviewer services should not be overloaded with translation
logic. Shared utility code is fine, but role state, directories, prompts, and
permissions should remain separate.

## 16. Relationship To Existing Translation

Keep the current translation UI surfaces:

- gateway Chinese-to-English / English-to-Chinese
- role-console output translation
- user input translation

Those are interactive-message translation features. Under this plan, VCM can
route their translation work to Codex Translator so terminology and style benefit
from the long-lived session and memory files.

Codex file translation is a document-production feature. It produces durable
project-local files and uses Codex session context plus translation memory.

Conversation translation and file translation may share translation settings UI
concepts such as target language and style, but they must not share runtime
caches. Conversation results stay task-temporary; file results stay
project-durable.

## 17. Implementation Phases

### Phase 1: Design And Harness

- Add translator role docs and prompts.
- Add `.ai/codex-translator` harness files.
- Add `file-translations/` directory contract.
- Define index, request, progress, and report schemas.
- Define Codex hook result contract for `last_assistant_message` and
  `transcript_path`.

### Phase 2: Backend Job Model

- Implement source hash and de-duplication.
- Implement job create/list/read/resume.
- Persist output under `<baseRepoRoot>/.ai/vcm/file-translations/`.
- Preserve file translation state during task cleanup, including inline-task
  cleanup where `<baseRepoRoot>` equals `<taskRepoRoot>`.
- Ensure conversation translation cleanup still removes only
  `<taskRepoRoot>/.ai/vcm/translation/<task>/`.

### Phase 3: Codex Session Integration

- Add `codex-translator` role/session support.
- Reuse Codex embedded terminal startup with model/effort selectors.
- Add hook endpoints and running/idle tracking.
- Send translation job prompts into the long-lived Codex session.
- Capture conversation translation output from `Stop.last_assistant_message`.
- Persist `transcript_path` for debugging and fallback parsing.

### Phase 4: UI

- Add sidebar `File Translation` group.
- Add job list/status/result/report views.
- Add Codex Translator terminal surface.
- Add duplicate detection and force retranslate UX.
- Reuse the existing role-console translation panel for conversation
  translation results.

### Phase 5: QA And Recovery

- Add Markdown structure checks.
- Add glossary consistency checks.
- Add missing-section detection.
- Add resume tests with partial output.
- Test with `docs/whitepaper-v0.8.md` scale files.

## 18. Open Questions

- Should the default output remain only under `.ai/vcm/file-translations/`, or
  should VCM also offer an optional export path beside the source document?
- Should there be one Codex Translator session per project, or one per
  target-language/profile pair?
- Should memory updates require user approval, or can Codex update glossary and
  style-guide files automatically with a report entry?
- Should completed translations be considered local VCM state only, or should
  VCM offer a "promote to repo doc" workflow for commit-ready translations?
- Should conversation translation keep API translation as a user-selectable
  fallback, or should Codex Translator be the only provider once enabled?

## 19. Recommended Defaults

- One Codex Translator session per base repository and target language.
- Store all job outputs under `.ai/vcm/file-translations/` by default.
- Resolve that path from `<baseRepoRoot>`, never from a task worktree.
- Keep conversation translation under `<taskRepoRoot>/.ai/vcm/translation/`
  because it is temporary task runtime state.
- Use `Stop.last_assistant_message` as the normal result channel for
  conversation translation.
- Persist `transcript_path` on every Codex Translator turn for recovery and
  debugging.
- Never parse raw Codex embedded terminal output for translation content.
- Do not edit source documents or project docs during translation.
- Require explicit user action to export or promote a translation into the
  normal repository tree.
- Let Codex update `memory/glossary.md` and `memory/decisions.md`, but require
  every update to be summarized in `report.md`.
- Prefer whole-file reading plus section-by-section file writes in one long-lived
  Codex session.
