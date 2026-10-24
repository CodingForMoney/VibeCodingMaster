import { NODE_TOOL_ARGUMENT_PARSER, NODE_TOOL_HTTP, renderNodeToolHeader } from "./node-tool-runtime.js";

export function renderVcmTaskStateSkillRules(): string {
  return `## Purpose

Use this skill only as project-manager to declare the current task workflow checkpoint to VCM.

The declaration is recoverable context, not a workflow controller. It does not authorize a transition, replace handoff artifacts, or decide the next role.

## Declaration

Record a recoverable checkpoint with:

\`\`\`bash
.ai/tools/update-task-state --flow code-change --step architect-planning --status active
\`\`\`

Supply only fields that changed. Use \`none\` to clear branch or resume point. Repeat \`--evidence\` for evidence paths.

Declare the selected flow before its first dispatch, update the step before later PM dispatches, and update no-route checkpoints such as waiting for Gate Review or completion. Use \`vcm-ask-user\`, not this advisory declaration, whenever PM asks the user a question. Do not put task-state or workflow-approval fields in route-message frontmatter.

If declaration fails, report the warning when relevant and continue the existing workflow. Never delay routing, Gate Review, final acceptance, or task close because task state is unavailable.
`;
}

export function renderUpdateTaskStateTool(): string {
  return String.raw`${renderNodeToolHeader("Declare advisory VCM task workflow state.")}${NODE_TOOL_ARGUMENT_PARSER}${NODE_TOOL_HTTP}
function emit(status, message, state) {
  const payload = { status };
  if (message) {
    payload.message = message;
  }
  if (state !== undefined) {
    payload.state = state;
  }
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main() {
  const args = parseToolArguments(process.argv.slice(2), {
    description: "Declare advisory VCM task workflow state.",
    options: {
      "--flow": { dest: "flow" },
      "--step": { dest: "step" },
      "--branch": { dest: "branch" },
      "--resume-point": { dest: "resumePoint" },
      "--status": { dest: "status" },
      "--evidence": { dest: "evidence", append: true }
    }
  });

  if (process.env.VCM_ROLE !== "project-manager") {
    emit("warning", "Only project-manager may declare VCM task workflow state.");
    return 0;
  }

  const apiUrl = (process.env.VCM_API_URL || "").replace(/\/+$/, "");
  const taskSlug = (process.env.VCM_TASK_SLUG || "").trim();
  if (!apiUrl || !taskSlug) {
    emit("warning", "VCM_API_URL or VCM_TASK_SLUG is unavailable; task state was not updated.");
    return 0;
  }

  const payload = {};
  for (const key of ["flow", "step", "branch", "resumePoint", "status"]) {
    if (args[key] !== undefined) {
      payload[key] = args[key];
    }
  }
  if (args.evidence.length > 0) {
    payload.evidenceRefs = args.evidence;
  }

  if (Object.keys(payload).length === 0) {
    emit("warning", "No task workflow fields were supplied.");
    return 0;
  }

  const url = apiUrl + "/api/tasks/" + encodeURIComponent(taskSlug) + "/workflow-state";
  try {
    const response = await postJson(url, payload, 3000);
    if (!response.ok) {
      emit("warning", "Task state was not updated: HTTP Error " + response.status + ": " + response.statusText);
      return 0;
    }
    emit("updated", undefined, JSON.parse(response.text));
  } catch (error) {
    emit("warning", "Task state was not updated: " + networkErrorText(error));
  }
  return 0;
}

main().then((code) => process.exit(code));
`;
}
