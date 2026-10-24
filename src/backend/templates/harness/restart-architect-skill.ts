import { NODE_TOOL_ARGUMENT_PARSER, NODE_TOOL_HTTP, renderNodeToolHeader } from "./node-tool-runtime.js";

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
  return String.raw`${renderNodeToolHeader("Schedule the Architect post-planning restart.")}${NODE_TOOL_HTTP}
function emit(status, fields) {
  process.stdout.write(JSON.stringify({ status, ...(fields || {}) }) + "\n");
}

async function main() {
  if (process.env.VCM_ROLE !== "architect") {
    emit("rejected", { message: "Only architect may schedule the post-planning restart." });
    return 2;
  }

  const apiUrl = (process.env.VCM_API_URL || "").replace(/\/+$/, "");
  const taskSlug = (process.env.VCM_TASK_SLUG || "").trim();
  if (!apiUrl || !taskSlug) {
    emit("rejected", { message: "VCM_API_URL or VCM_TASK_SLUG is unavailable." });
    return 2;
  }

  const url = apiUrl + "/api/tasks/" + encodeURIComponent(taskSlug) + "/sessions/architect/restart-after-planning";
  let response;
  try {
    response = await postJson(url, {}, 5000);
  } catch (error) {
    emit("failed", { message: networkErrorText(error) });
    return 2;
  }
  if (!response.ok) {
    let message = "HTTP Error " + response.status + ": " + response.statusText;
    try {
      const payload = JSON.parse(response.text);
      message = (payload.error && payload.error.message) || message;
    } catch {
      // Keep the HTTP status message when the error body is not JSON.
    }
    emit("rejected", { message });
    return 2;
  }
  try {
    const payload = JSON.parse(response.text);
    emit(payload.status || "scheduled", {
      taskSlug,
      sessionId: payload.sessionId ?? null,
      memoryCandidatePath: payload.memoryCandidatePath ?? null
    });
    return 0;
  } catch (error) {
    emit("failed", { message: error.message });
    return 2;
  }
}

main().then((code) => process.exit(code));
`;
}
