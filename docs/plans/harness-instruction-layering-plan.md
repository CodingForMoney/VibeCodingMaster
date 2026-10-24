# Harness Instruction Layering

Last updated: 2026-10-24

Status: approved direction, not yet implemented

## Goal

Give every harness rule exactly one authoritative home in the layer that fits
its nature, and load scenario-specific rules only when a role is in that
scenario. Prompts should carry only what requires model judgment; protocol,
formats, and mechanically decidable checks belong to code and tools.

## Current Gaps

The downstream harness has four instruction layers: the root `CLAUDE.md` VCM
managed block (loaded by every role), role definitions under
`.claude/agents/`, skills under `.claude/skills/`, and backend-injected
prompts (Gate, retrospective, restart). Their responsibilities overlap.

- Repeated rules: the same flow is described in the `CLAUDE.md` managed block,
  the Project Manager definition, skills, and backend code. For example, Gate
  Review is referenced 11 times in `CLAUDE.md`, 18 times in the Project Manager
  definition, and 13 times across skills. Edits to one copy drift from the
  others.
- Global loading of PM-only rules: the `VCM Task Flow` section of the managed
  block is loaded by Coder, Tester, and Reviewer although only Project Manager
  routes flows.
- Scenario rules loaded every turn: by section size, about 56% of the Project
  Manager definition is flow-specific, about 70% of the Architect definition is
  mode-specific (planning, docs sync, Diagnosis, Debug), and about 76% of the
  Reviewer definition is gate-specific. Each turn needs one flow, one mode, or
  one gate.
- Mixed content types in role definitions: identity and judgment criteria,
  workflow protocol, artifact formats, and prohibitions share one file. The
  backend already derives allowed workflow transitions, and the artifact
  registry already owns required headings.
- Skills used as mandatory protocol steps: 9 of 13 skills wrap a `.ai/tools`
  command (route-message, workflow-review, ask-user, task-state, gate-review,
  restart-architect, long-running-validation, propose-memory,
  report-harness-issue). Correct behavior depends on the model remembering to
  load the skill, although the backend already rejects invalid actions.
- Skill scope is prose only: descriptions such as "only as project-manager" are
  not enforced, and every role with the Skill tool sees all skill descriptions.
- Implementation limits leak into prompts: `vcm-long-running-validation`
  requires single top-level commands and repeated `watch-job` calls because the
  Bash guard parses commands with regular expressions and Bash tool calls are
  time-bounded.
- Contradictory ownership: Project Manager must not perform technical analysis,
  yet `vcm-final-acceptance` asks it to classify changed files as expected,
  supporting, approved deviations, unexplained, or high-risk.

## Design

### Layer Assignment

| Layer | Contains | Excludes |
| --- | --- | --- |
| `CLAUDE.md` managed block | Conventions every role needs: VCM message markers, artifact submission, background-job limits, durable-doc ownership | Flow routing, gate rules, role-specific procedure |
| Role definition | Identity, responsibilities, judgment criteria, prohibitions that need judgment | Flow tables, mode procedures, artifact templates |
| Scenario rules (skills or backend-injected sections) | One flow, one Architect mode, or one gate | Rules for other scenarios |
| Code and tools | Workflow protocol, artifact templates, mechanically decidable checks | Judgment |

### On-Demand Scenario Loading

- Reviewer: the Gate Review request prompt injects only the requested gate's
  rules. The Reviewer definition keeps shared review principles and output
  contract.
- Architect: each dispatch or restart injects only the active mode's rules
  (planning, docs sync, Debug, Diagnosis). This complements the existing
  planning-session restart.
- Project Manager: flow-specific rules load for the active flow only. Once
  routing moves to deterministic backend control, PM keeps user communication,
  genuinely ambiguous decisions, and reporting.

### Protocol In Code, Instructions In Errors

- Backend rejections state the exact next action, so a role that skipped a
  skill still receives correct guidance on its first rejected attempt.
- Every `.ai/tools` command provides `--help` and, for artifacts, a template
  output generated from the artifact registry, so templates and validators
  share one definition.
- Protocol skills become reference documentation instead of the primary
  enforcement mechanism.

### Single Source Per Rule

- Each flow, gate, and artifact contract has one authoritative description.
  Other layers reference it instead of restating it.
- A harness test fails when a managed template restates a contract owned
  elsewhere, or when a rendered artifact template does not pass its registry
  check in draft mode.

### Mechanical Checks Leave Prompts

- Final Acceptance scope traceability is computed by the backend: changed files
  are compared with the Scaffold Manifest and a high-risk path pattern list.
  Project Manager reports the computed result and routes unexplained files to
  the owning role.
- Now that the harness tools run on Node, long-running validation can become
  one blocking start-and-wait command so the watcher protocol is owned by the
  tool, not the prompt.

## Rollout

1. Reviewer per-gate injection: the backend already knows the requested gate,
   so this is the smallest change with a large per-request reduction.
2. Remove PM-only flow content from the `CLAUDE.md` managed block and
   deduplicate flow descriptions to one authoritative copy.
3. Actionable backend rejection messages and tool-generated artifact
   templates; demote protocol skills to reference documentation.
4. Architect per-mode injection.
5. Backend-computed Final Acceptance scope traceability.
6. Project Manager per-flow loading, aligned with moving routing into backend
   control.

## Measurement

Use the harness evaluation loop (`docs/plans/harness-evaluation-loop-plan.md`)
task records to compare prompt size, rework loops, and tokens per role before
and after each rollout step.

## Open Questions

- Delivery mechanism for scenario rules: skills preloaded by the backend,
  `--append-system-prompt` sections, or the dispatch message body. Each differs
  in cache behavior and in how a resumed Session picks up updated rules.
- Whether Claude Code supports per-agent skill allowlists; if not, skill
  descriptions remain globally visible and identity stays enforced by the
  backend.
- How downstream projects that customized role definitions outside managed
  blocks migrate when managed content moves into scenario sections.

## Related

- `docs/plans/harness-evaluation-loop-plan.md`
- `docs/ARCHITECTURE.md` Managed Workflow Artifact Ownership
