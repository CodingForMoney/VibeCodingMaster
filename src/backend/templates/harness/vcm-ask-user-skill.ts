export function renderVcmAskUserSkillRules(): string {
  return `## Purpose

Use this skill whenever Project Manager asks the user a question.

## Ask And Wait

Submit the complete user-facing question, including the context needed to answer:

\`\`\`bash
.ai/tools/vcm-ask-user --question "<exact question>"
\`\`\`

After the tool returns \`awaiting_user\`, end the turn. VCM delivers the registered question as the Round Final Reply through the existing display, translation, and Gateway paths. Do not rely on a separate final message to supply missing context. Do not request Workflow Review, write a route message, run a Gate, or advance the workflow in the same turn.

Every question pauses the workflow. PM may defer a question by not asking it; once PM asks, only a new direct user message resumes the workflow. The previous workflow approval is canceled, so request a fresh approval before the next dispatch.
`;
}

export function renderAskUserTool(): string {
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
    parser = argparse.ArgumentParser(description="Pause VCM workflow for an exact user question.")
    parser.add_argument("--question", required=True)
    args = parser.parse_args()

    if os.environ.get("VCM_ROLE") != "project-manager":
        emit("failed", "Only project-manager may ask the user through VCM workflow control.")
        return 2

    question = args.question.strip()
    if not question:
        emit("failed", "A non-empty user question is required.")
        return 2

    api_url = os.environ.get("VCM_API_URL", "").rstrip("/")
    task_slug = os.environ.get("VCM_TASK_SLUG", "").strip()
    if not api_url or not task_slug:
        emit("failed", "VCM_API_URL or VCM_TASK_SLUG is unavailable; the workflow was not paused.")
        return 2

    url = f"{api_url}/api/tasks/{urllib.parse.quote(task_slug, safe='')}/ask-user"
    request = urllib.request.Request(
        url,
        data=json.dumps({"question": question}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            state = json.loads(response.read().decode("utf-8"))
        emit("awaiting_user", state=state)
        return 0
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        emit("failed", f"VCM rejected the user question: HTTP {error.code} {detail}")
    except (OSError, ValueError, urllib.error.URLError) as error:
        emit("failed", f"VCM could not register the user question: {error}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
`;
}
