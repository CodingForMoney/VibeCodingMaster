import { NODE_TOOL_ARGUMENT_PARSER, NODE_TOOL_HTTP, renderNodeToolHeader } from "./node-tool-runtime.js";

export function renderResolveDurableDocAssignmentTool(): string {
  return String.raw`${renderNodeToolHeader("Assign a VCM durable-document update to a workflow role.")}${NODE_TOOL_ARGUMENT_PARSER}${NODE_TOOL_HTTP}
function emit(status, message) {
  const payload = { status };
  if (message) {
    payload.message = message;
  }
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main() {
  const args = parseToolArguments(process.argv.slice(2), {
    description: "Assign a VCM durable-document update to a workflow role.",
    options: {
      "--assignment": { dest: "assignment", required: true },
      "--owner": { dest: "owner", required: true, choices: ["architect", "coder", "tester"] }
    }
  });

  if (process.env.VCM_ROLE !== "project-manager") {
    emit("rejected", "Only project-manager may resolve a durable-document owner.");
    return 2;
  }

  const apiUrl = (process.env.VCM_API_URL || "").replace(/\/+$/, "");
  const taskSlug = (process.env.VCM_TASK_SLUG || "").trim();
  if (!apiUrl || !taskSlug) {
    emit("rejected", "VCM_API_URL or VCM_TASK_SLUG is unavailable.");
    return 2;
  }

  let response;
  try {
    response = await postJson(apiUrl + "/api/projects/harness/memory/assignments/owner", {
      taskSlug,
      assignmentId: args.assignment,
      owner: args.owner
    }, 5000);
  } catch (error) {
    emit("failed", "VCM could not record the owner: " + networkErrorText(error));
    return 2;
  }
  if (!response.ok) {
    emit("rejected", "VCM rejected the owner: HTTP " + response.status + " " + response.text);
    return 2;
  }
  emit("accepted");
  return 0;
}

main().then((code) => process.exit(code));
`;
}
