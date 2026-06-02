import type { VcmRoleMessage } from "../../shared/types/message.js";

export function renderMessageEnvelope(message: VcmRoleMessage): string {
  const artifactRefs = message.artifactRefs.length > 0
    ? message.artifactRefs.map((artifact) => `- ${artifact}`).join("\n")
    : "- none";
  const routeFileExample = message.toRole === "project-manager"
    ? ".ai/vcm/handoffs/messages/project-manager-<target-role>.md"
    : `.ai/vcm/handoffs/messages/${message.toRole}-project-manager.md`;

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
- If you need to send a VCM message after handling this, write or update .ai/vcm/handoffs/messages/<your-role>-<target-role>.md.
- Non-PM roles reply only to project-manager, for example ${routeFileExample}.
- After writing a route file, end this Claude Code turn immediately.
- Do not poll, loop, or wait for another role in this turn. VCM scans route files after your Stop hook and delivers later replies in a new turn.
[/VCM MESSAGE]
`;
}

export function renderManualStagePrompt(message: VcmRoleMessage): string {
  const target = message.bodyPath ?? `VCM message ${message.id}`;
  return `Read and handle VCM message ${message.id} at ${target}`;
}
