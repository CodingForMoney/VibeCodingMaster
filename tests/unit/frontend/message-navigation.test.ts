import { describe, expect, it } from "vitest";
import { selectAutoDispatchRole } from "../../../src/frontend/state/message-navigation.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../../src/shared/types/message.js";
import type { RoleName } from "../../../src/shared/types/role.js";

describe("selectAutoDispatchRole", () => {
  it("does not switch on initial load or manual mode", () => {
    const dispatching = createMessage("msg_1", "coder", "2026-05-31T10:00:00.000Z");

    expect(selectAutoDispatchRole(null, [dispatching], createOrchestration("auto"))).toBeNull();
    expect(selectAutoDispatchRole([], [dispatching], createOrchestration("manual"))).toBeNull();
  });

  it("selects the target role when a message newly becomes dispatching in auto mode", () => {
    const previous = [createMessage("msg_1", "coder")];
    const next = [createMessage("msg_1", "coder", "2026-05-31T10:00:00.000Z")];

    expect(selectAutoDispatchRole(previous, next, createOrchestration("auto"))).toBe("coder");
  });

  it("does not reselect a message that was already dispatching", () => {
    const previous = [createMessage("msg_1", "reviewer", "2026-05-31T10:00:00.000Z")];
    const next = [createMessage("msg_1", "reviewer", "2026-05-31T10:00:00.000Z")];

    expect(selectAutoDispatchRole(previous, next, createOrchestration("auto"))).toBeNull();
  });

  it("uses the latest dispatching message when multiple messages are dispatching together", () => {
    const previous = [
      createMessage("msg_1", "project-manager"),
      createMessage("msg_2", "coder")
    ];
    const next = [
      createMessage("msg_1", "project-manager", "2026-05-31T10:00:00.000Z"),
      createMessage("msg_2", "coder", "2026-05-31T10:00:01.000Z")
    ];

    expect(selectAutoDispatchRole(previous, next, createOrchestration("auto"))).toBe("coder");
  });
});

function createMessage(
  id: string,
  toRole: RoleName,
  dispatchingAt?: string
): VcmRoleMessage {
  return {
    id,
    taskSlug: "demo-task",
    fromRole: toRole === "project-manager" ? "coder" : "project-manager",
    toRole,
    type: toRole === "project-manager" ? "result" : "task",
    body: "message body",
    artifactRefs: [],
    createdAt: id === "msg_1" ? "2026-05-31T09:59:00.000Z" : "2026-05-31T09:59:01.000Z",
    dispatchingAt
  };
}

function createOrchestration(mode: VcmOrchestrationState["mode"]): VcmOrchestrationState {
  return {
    taskSlug: "demo-task",
    mode,
    updatedAt: "2026-05-31T10:00:00.000Z"
  };
}
