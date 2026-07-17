export function renderVcmTaskStateSkillRules(): string {
  return `## Purpose

Use this skill only as project-manager to declare the current task workflow checkpoint to VCM.

The declaration is recoverable context, not a workflow controller. It does not authorize a transition, replace handoff artifacts, or decide the next role.

## Declaration

For a PM role dispatch, put the current declaration in the route-file frontmatter:

\`\`\`yaml
workflow_flow: code-change
workflow_step: coder-implementation
workflow_branch: none
workflow_resume_point: none
workflow_status: active
workflow_evidence_refs: .ai/vcm/handoffs/architecture-plan.md
\`\`\`

For a checkpoint without a role route, run:

\`\`\`bash
.ai/tools/update-task-state --flow code-change --step awaiting-user --status awaiting-user
\`\`\`

Supply only fields that changed. Use \`none\` to clear branch or resume point. Repeat \`--evidence\` for evidence paths.

Declare the selected flow before its first dispatch, update the step on later PM dispatches, and update no-route checkpoints such as waiting for the user, waiting for Gate Review, or completion.

If declaration fails, report the warning when relevant and continue the existing workflow. Never delay routing, Gate Review, final acceptance, or task close because task state is unavailable.
`;
}

export function renderUpdateTaskStateTool(): string {
  return `#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def emit(status, message=None, state=None):
    payload = {"status": status}
    if message:
        payload["message"] = message
    if state is not None:
        payload["state"] = state
    print(json.dumps(payload, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="Declare advisory VCM task workflow state.")
    parser.add_argument("--flow")
    parser.add_argument("--step")
    parser.add_argument("--branch")
    parser.add_argument("--resume-point")
    parser.add_argument("--status")
    parser.add_argument("--evidence", action="append", default=[])
    args = parser.parse_args()

    if os.environ.get("VCM_ROLE") != "project-manager":
        emit("warning", "Only project-manager may declare VCM task workflow state.")
        return 0

    api_url = os.environ.get("VCM_API_URL", "").rstrip("/")
    task_slug = os.environ.get("VCM_TASK_SLUG", "").strip()
    if not api_url or not task_slug:
        emit("warning", "VCM_API_URL or VCM_TASK_SLUG is unavailable; task state was not updated.")
        return 0

    payload = {}
    for key, value in (
        ("flow", args.flow),
        ("step", args.step),
        ("branch", args.branch),
        ("resumePoint", args.resume_point),
        ("status", args.status),
    ):
        if value is not None:
            payload[key] = value
    if args.evidence:
        payload["evidenceRefs"] = args.evidence

    if not payload:
        emit("warning", "No task workflow fields were supplied.")
        return 0

    url = f"{api_url}/api/tasks/{urllib.parse.quote(task_slug, safe='')}/workflow-state"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            state = json.loads(response.read().decode("utf-8"))
        emit("updated", state=state)
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as error:
        emit("warning", f"Task state was not updated: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
}
