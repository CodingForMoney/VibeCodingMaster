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

If VCM reports `scheduled`, write the completed Architect-to-PM route message and end the turn. VCM restarts Architect only after the route is accepted by PM.

Do not use this skill for incomplete planning, user clarification, Debug Mode, Architecture Diagnosis Mode, or docs sync.
