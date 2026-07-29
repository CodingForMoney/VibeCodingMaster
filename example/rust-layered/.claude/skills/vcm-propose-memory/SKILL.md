---
name: vcm-propose-memory
description: Use only when VCM requests a role memory proposal during Task Harness Review.
---

# VCM Propose Memory Skill

Use this skill only when VCM explicitly requests a memory proposal or
planning-session memory candidate and provides an exact path.

## Rules

- Treat every `<VCM-memory>` block as read-only. This skill creates a proposal;
  it never edits active memory.
- Write only to the exact path assigned by VCM. It must be either a role draft
  under `.ai/vcm/memory-review/runs/<run-id>/drafts/` or a planning candidate
  under `.ai/vcm/memory-review/candidates/` in the active task worktree.
- If VCM did not provide a path, do not create a proposal.
- Propose only verified, durable, reusable project knowledge supported by task
  evidence.
- Do not record task narrative, temporary state, unverified conclusions, or
  Harness rules.
- Do not edit handoff artifacts or route messages from this skill.

## Draft Format

```markdown
# Memory Proposal
Decision: update | no-change

## Add

## Update

## Remove

## Evidence
```

Use `Decision: no-change` when the completed task produced no qualifying
memory. End the turn after writing the assigned draft.
