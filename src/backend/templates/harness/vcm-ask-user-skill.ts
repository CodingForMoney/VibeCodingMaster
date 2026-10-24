import { NODE_TOOL_ARGUMENT_PARSER, NODE_TOOL_HTTP, renderNodeToolHeader } from "./node-tool-runtime.js";

export function renderVcmAskUserSkillRules(): string {
  return `## Purpose

Use this skill whenever Project Manager asks the user a question.

## Ask And Wait

Submit the complete user-facing question, including the context needed to answer:

\`\`\`bash
.ai/tools/vcm-ask-user --question "<exact question>"
\`\`\`

After the tool returns \`awaiting_user\`, present the complete question and necessary context in your final reply, then end the turn and wait for the user. The tool registers the workflow wait; it does not deliver your question. Do not request Workflow Review, write a route message, run a Gate, or advance the workflow in the same turn.

Every question pauses the workflow. PM may defer a question by not asking it; once PM asks, only a new direct user message resumes the workflow. The previous workflow approval is canceled, so request a fresh approval before the next dispatch.
`;
}

export function renderAskUserTool(): string {
  return String.raw`${renderNodeToolHeader("Pause VCM workflow for an exact user question.")}${NODE_TOOL_ARGUMENT_PARSER}${NODE_TOOL_HTTP}
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
    description: "Pause VCM workflow for an exact user question.",
    options: { "--question": { dest: "question", required: true } }
  });

  if (process.env.VCM_ROLE !== "project-manager") {
    emit("failed", "Only project-manager may ask the user through VCM workflow control.");
    return 2;
  }

  const question = args.question.trim();
  if (!question) {
    emit("failed", "A non-empty user question is required.");
    return 2;
  }

  const apiUrl = (process.env.VCM_API_URL || "").replace(/\/+$/, "");
  const taskSlug = (process.env.VCM_TASK_SLUG || "").trim();
  if (!apiUrl || !taskSlug) {
    emit("failed", "VCM_API_URL or VCM_TASK_SLUG is unavailable; the workflow was not paused.");
    return 2;
  }

  const url = apiUrl + "/api/tasks/" + encodeURIComponent(taskSlug) + "/ask-user";
  let response;
  try {
    response = await postJson(url, { question }, 5000);
  } catch (error) {
    emit("failed", "VCM could not register the user question: " + networkErrorText(error));
    return 1;
  }
  if (!response.ok) {
    emit("failed", "VCM rejected the user question: HTTP " + response.status + " " + response.text);
    return 1;
  }
  try {
    emit("awaiting_user", undefined, JSON.parse(response.text));
    return 0;
  } catch (error) {
    emit("failed", "VCM could not register the user question: " + error.message);
    return 1;
  }
}

main().then((code) => process.exit(code));
`;
}
