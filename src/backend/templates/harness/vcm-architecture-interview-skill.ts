export function renderVcmArchitectureInterviewSkillRules(): string {
  return `## Purpose

Use this skill only when project-manager routes the Architect Interview step of Code-Change Flow. Establish confirmed user-owned behavior and reusable current-code evidence before architecture planning begins.

During an active Architect Interview, handle the user's answers and final confirmation only as defined by this skill.

## Boundaries

- Do not write or revise \`.ai/vcm/handoffs/architecture-plan.md\`.
- Do not create code scaffold, \`VCM:CODE\` markers, production code, tests, or implementation commits.
- Do not ask the user to choose technical implementation, modules, files, dependencies, callable surfaces, task splitting, workload, validation commands, or test strategy.
- Do not create \`CONTEXT.md\`, ADRs, or durable documentation during the interview.

## Evidence First

- Read the PM route, task request, relevant durable docs, generated context, and the complete current-worktree behavior path inside the affected feature or module boundary.
- If a fact can be established from the worktree or available tools, investigate it instead of asking the user.
- If code, docs, and the user's requested behavior conflict, state the concrete conflict and ask which user-visible behavior is intended.
- Maintain \`.ai/vcm/handoffs/architecture-evidence.md\` while reading. Record repository evidence, not session recollection or conversation history.

## Feasibility Draft

- Before presenting the brief for confirmation, draft the correctness-critical mechanisms the outcome needs — the key data and role paths and the invariants only, not a full plan or scaffold — and check them for feasibility against current code and the authoritative spec or domain docs (for example, the project whitepaper).
- Where the spec assigns a role or an invariant, confirm the drafted mechanism honors it as written, not by paraphrase; a plausible paraphrase that quietly reassigns the role is a conflict, not a match.
- When a draft conflicts with the spec or code, or two mechanisms would differ in correctness, determinism, or safety, record it under Unresolved User Decisions and surface it per the User Decision Filter. Do not defer the choice into planning.

## User Decision Filter

Ask only when two reasonable answers would materially change user-observable behavior, data meaning or business rules, lifecycle or failure behavior, compatibility or migration, permissions or security, irreversible effects, or an external contract.

Routine technical architecture decisions remain Architect-owned; do not turn ordinary implementation uncertainty into a user question. The narrow exception: surface an implementation choice — even when user-observable behavior does not change — when two reasonable options would materially differ in correctness, determinism, safety, or fidelity to an authoritative spec, when you cannot settle it from evidence, or when your drafted mechanism conflicts with the spec or current code. Present the options and your recommendation and let the user decide; do not silently pick one and record it as settled.

## Interview Protocol

- Ask one question per turn and wait for the user's answer.
- Explain why the decision affects the task and give the Architect's recommended answer with a concise rationale.
- Offer alternatives only when they represent a real user-owned trade-off.
- Treat exploratory, tentative, or hypothetical answers as discussion, not confirmation.
- After each resolved answer, update \`.ai/vcm/handoffs/architecture-brief.md\` immediately. Replace superseded content; do not append a transcript or decision history.
- During this formal interview, continue directly with the user across turns. Do not report each answer to project-manager.
- On every resumed interview turn, read the current brief before asking the next question.
- If planning returns to this interview with a newly discovered user-owned decision, set the brief status to \`interviewing\` and record that decision under Unresolved User Decisions before asking it.

## Artifact

Maintain exactly this structure:

\`\`\`md
# Architecture Brief: <task>

Architecture Brief Status: interviewing|confirmed

## Accepted Outcome

...

## Confirmed User Decisions

...

## Existing Constraints

...

## Unresolved User Decisions

...

## User Confirmation

...
\`\`\`

Record concise confirmed requirements and constraints. Tag each entry under Confirmed User Decisions with its provenance and depth — [user-stated | architect-proposed, user-approved | architect-inferred] and [intent-level | mechanism-level] — and record the user's real input faithfully as a short summary; never present an architect inference as a user requirement. Record correctness-critical mechanism choices surfaced during the interview with their options, your recommendation, the user's decision, and the rejected alternative, so later stages can tell a chosen mechanism from an inferred one. Keep this to decisions and their provenance — not a full implementation design, and not a transcript. Use \`None\` under Unresolved User Decisions only when no user-owned decision remains.

Maintain the evidence artifact with this structure:

\`\`\`md
# Architecture Evidence: <task>

Architecture Evidence Status: incomplete|complete

## Planning Boundary

## Entry Points And Behavior Paths

## State And Lifecycle

## Callers And Consumers

## External Boundaries

## Code And Docs Conflicts

## Evidence Commands
\`\`\`

Identify inspected files and symbols, callers or consumers, state and side effects, verified behavior, and the worktree revision. Replace stale evidence instead of appending history.

## Completion

When no unresolved user decision remains, present the complete brief to the user and ask for explicit confirmation. If the user corrects it, update the brief and continue the interview.

Only after explicit confirmation and complete code evidence:

1. Set \`Architecture Brief Status: confirmed\`.
2. Record the confirmation under User Confirmation.
3. Set \`Architecture Evidence Status: complete\`.
4. Report both artifact paths to project-manager with \`vcm-route-message\`.
5. End the turn immediately.

Do not continue into architecture planning. Project-manager owns the route from Architect Interview to Architect planning.`;
}
