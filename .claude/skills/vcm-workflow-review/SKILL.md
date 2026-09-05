---
name: vcm-workflow-review
description: Use before every project-manager dispatch to Architect, Coder, or Tester so VCM can approve the workflow transition.
---

# VCM Workflow Review Skill

## Purpose

Use this skill before every Project Manager dispatch to Architect, Coder, or Tester. VCM validates the proposed transition against the confirmed task Flow Record and real task artifacts.

## Submission

Read the current `.ai/vcm/handoffs/workflow-progress.md`. Copy its Revision, Flow, Status, and Dispatch History exactly, increment Revision by one, and propose one dispatch:

```md
# Workflow Progress: <task-slug>

Revision: <previous-revision + 1>
Flow: <copy confirmed Flow exactly>
Status: <copy confirmed Status exactly>

## Dispatch History

<copy exactly; use none when empty>

## Proposed Dispatch

Requested Flow: <none|code-change|architect-debug|architecture-diagnosis|docs-only|validation-only>
Target Role: <architect|coder|tester>
Evidence: <current artifact, Gate result, or user request supporting this dispatch>

## User Authorization

Authorization Text: none
Violated Rule: none

## User-Approved Follow-Up

Approval Text: none
```

Use `Requested Flow` only to start a flow, switch a top-level flow, enter or replace a Branch, or return from a Branch. Otherwise use `none`.

Submit the candidate outside `.ai/vcm`:

```text
.ai/tools/vcm-artifact workflow-progress --file <candidate> --mode final
```

An accepted submission grants exactly one matching PM route. Then use `vcm-route-message` for that target role.

If VCM rejects the transition, remain in the current PM turn and choose a legal dispatch. Do not write the route file first.

## User Authorization

Only the user's explicit instruction may authorize a rejected transition.

If the current user instruction already explicitly authorizes the exact rejected transition, reuse that instruction verbatim as `Authorization Text`. Do not ask the user to confirm it again.

If no such instruction exists, use `vcm-ask-user` with the exact authorization question, ask it, and wait.

Resubmit the unchanged transition with:

```text
Authorization Text: <user's exact authorization>
Violated Rule: <copy the exact VCM rejection reason>
```

VCM binds that authorization to this exact task state, flow, target role, evidence, and violated rule. It applies once and is consumed by the matching dispatch. Do not infer, broaden, or reuse authorization.

## User-Approved Post-Validation Work

When Tester has returned `pass`, validation-adequacy and code-diff are both successful, and the user explicitly approves additional Tester-owned work in the current task, propose Tester again with:

```text
Authorization Text: none
Violated Rule: none
Approval Text: <user's exact approval>
```

This is a normal one-time follow-up approval, not a Workflow Override. Do not use it before both Gates are successful, for required unresolved coverage, for another owner, or without the user's exact approval. After Tester completes the approved work, rerun Tester validation and every invalidated Gate.

## Completion

When the active flow has completed without another role dispatch, increment Revision, copy the confirmed history exactly, set `Status: completed`, and set every Proposed Dispatch, User Authorization, and User-Approved Follow-Up value to `none`. VCM accepts completion only when the flow's required final artifact and Gate evidence exists.
