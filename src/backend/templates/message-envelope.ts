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
- Reply to project-manager with vcmctl reply when complete, blocked, or unclear.
[/VCM MESSAGE]
`;
}

export function renderManualStagePrompt(message: VcmRoleMessage): string {
  const target = message.bodyPath ?? `VCM message ${message.id}`;
  return `Read and handle VCM message ${message.id} at ${target}`;
}
