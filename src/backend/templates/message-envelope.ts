import type { VcmRoleMessage } from "../../shared/types/message.js";

export function renderMessageEnvelope(message: VcmRoleMessage): string {
  const artifactRefs = message.artifactRefs.length > 0
    ? message.artifactRefs.map((artifact) => `- ${artifact}`).join("\n")
    : "- none";
  return `
[VCM MESSAGE]
id: ${message.id}
task: ${message.taskSlug}
from: ${message.fromRole}
to: ${message.toRole}
type: ${message.type}

${message.body}

Artifact refs:
${artifactRefs}

Instructions:
- Read the message and execute only within this VCM task.
- Submit every VCM route file through the vcm-route-message skill and .ai/tools/vcm-artifact.
- If PM sends a VCM message after handling this, submit .ai/vcm/handoffs/messages/project-manager-<target-role>.md.
- If a non-PM role sends a VCM message after handling this, submit only .ai/vcm/handoffs/messages/<your-role>-project-manager.md.
- After VCM accepts a route file, end this Claude Code turn immediately.
- Do not poll, loop, or wait for another role in this turn. VCM scans route files after your Stop hook and delivers later replies in a new turn.
[/VCM MESSAGE]
`;
}

export function renderManualStagePrompt(message: VcmRoleMessage): string {
  const target = message.bodyPath ?? `VCM message ${message.id}`;
  return `[VCM MESSAGE]\nid: ${message.id}\nRead and handle the VCM message at ${target}.\n[/VCM MESSAGE]`;
}
