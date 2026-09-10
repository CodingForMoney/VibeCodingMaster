---
name: vcm-ask-user
description: Use whenever project-manager asks the user a question and must pause the workflow.
---

# VCM Ask User Skill

## Purpose

Use this skill whenever Project Manager asks the user a question.

## Ask And Wait

Submit the complete user-facing question, including the context needed to answer:

```bash
.ai/tools/vcm-ask-user --question "<exact question>"
```

After the tool returns `awaiting_user`, present the complete question and necessary context in your final reply, then end the turn and wait for the user. The tool registers the workflow wait; it does not deliver your question. Do not request Workflow Review, write a route message, run a Gate, or advance the workflow in the same turn.

Every question pauses the workflow. PM may defer a question by not asking it; once PM asks, only a new direct user message resumes the workflow. The previous workflow approval is canceled, so request a fresh approval before the next dispatch.
