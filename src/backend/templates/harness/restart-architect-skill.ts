export function renderRestartArchitectSkillRules(): string {
  return `## Purpose

Use this skill only after Architect has completed and committed the architecture plan and scaffold for Code-Change Flow.

Run:

\`\`\`bash
.ai/tools/request-architect-restart
\`\`\`

If VCM reports \`scheduled\` with a non-empty \`memoryCandidatePath\`, ensure
that one planning-session memory candidate exists at that exact path before
writing the completed route. Use \`vcm-propose-memory\` to create it when it is
absent. The candidate is a task-level provisional input for the later Auto
Memory review; it does not edit active memory.

If VCM reports \`already_scheduled\`, keep the existing candidate and pending
restart. Do not recreate either one.

Then write the completed Architect-to-PM route message and end the turn. VCM keeps the current Architect session and the same pending restart through any architecture-plan Gate revision rounds, then restarts it only after the latest route is accepted by PM and that Gate is approved or explicitly excepted.

Do not use this skill for incomplete planning, user clarification, Debug Mode, Architecture Diagnosis Mode, or docs sync.`;
}

export function renderRequestArchitectRestartTool(): string {
  return `#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def emit(status, **fields):
    payload = {"status": status, **fields}
    print(json.dumps(payload, ensure_ascii=False))


def main():
    if os.environ.get("VCM_ROLE") != "architect":
        emit("rejected", message="Only architect may schedule the post-planning restart.")
        return 2

    api_url = os.environ.get("VCM_API_URL", "").rstrip("/")
    task_slug = os.environ.get("VCM_TASK_SLUG", "").strip()
    if not api_url or not task_slug:
        emit("rejected", message="VCM_API_URL or VCM_TASK_SLUG is unavailable.")
        return 2

    url = (
        api_url
        + "/api/tasks/"
        + urllib.parse.quote(task_slug, safe="")
        + "/sessions/architect/restart-after-planning"
    )
    request = urllib.request.Request(
        url,
        data=b"{}",
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        emit(
            payload.get("status", "scheduled"),
            taskSlug=task_slug,
            sessionId=payload.get("sessionId"),
            memoryCandidatePath=payload.get("memoryCandidatePath"),
        )
        return 0
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            message = payload.get("error", {}).get("message", str(error))
        except Exception:
            message = str(error)
        emit("rejected", message=message)
        return 2
    except (OSError, ValueError, urllib.error.URLError) as error:
        emit("failed", message=str(error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
`;
}
