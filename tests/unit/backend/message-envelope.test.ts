import { describe, expect, it } from "vitest";
import { renderManualStagePrompt, renderMessageEnvelope } from "../../../src/backend/templates/message-envelope.js";
import type { VcmRoleMessage } from "../../../src/shared/types/message.js";

const message: VcmRoleMessage = {
  id: "msg_123",
  taskSlug: "demo-task",
  fromRole: "project-manager",
  toRole: "architect",
  type: "task",
  body: "Review the task.",
  artifactRefs: [],
  bodyPath: ".ai/vcm/handoffs/messages/project-manager-architect.md",
  createdAt: "2026-07-17T00:00:00.000Z"
};

describe("message envelope", () => {
  it("marks delivered role messages as VCM communication", () => {
    expect(renderMessageEnvelope(message)).toContain("[VCM MESSAGE]");
    expect(renderMessageEnvelope(message)).toContain("[/VCM MESSAGE]");
  });

  it("marks manual role-message prompts as VCM communication", () => {
    const prompt = renderManualStagePrompt(message);

    expect(prompt).toContain("[VCM MESSAGE]");
    expect(prompt).toContain("id: msg_123");
    expect(prompt).toContain("[/VCM MESSAGE]");
  });
});
