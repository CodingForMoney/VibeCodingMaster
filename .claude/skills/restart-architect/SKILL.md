---
name: restart-architect
description: Use after Architect completes and commits architecture planning and scaffold work.
---

# Restart Architect Skill

## Purpose

Use this skill only after Architect has completed and committed the architecture plan and scaffold for Code-Change Flow.

Run:

```bash
.ai/tools/request-architect-restart
```

If VCM reports `scheduled` with a non-empty `memoryCandidatePath`, ensure that
one planning-session memory candidate exists at that exact path before writing
the completed route. Use `vcm-propose-memory` to create it when it is absent.
The candidate is a task-level provisional input for the later Auto Memory
review; it does not edit active memory.

If VCM reports `already_scheduled`, keep the existing candidate and pending
restart. Do not recreate either one.

Then write the completed Architect-to-PM route message and end the turn. VCM keeps the current Architect session and the same pending restart through any architecture-plan Gate revision rounds, then restarts it only after the latest route is accepted by PM and that Gate is approved or explicitly excepted.

Do not use this skill for incomplete planning, user clarification, Debug Mode, Architecture Diagnosis Mode, or docs sync.
