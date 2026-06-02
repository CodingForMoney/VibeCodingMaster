import { describe, expect, it } from "vitest";
import {
  getMessageCounts,
  getVisibleMessageRecords
} from "../../../src/frontend/components/message-timeline.js";
import type { VcmRoleMessage } from "../../../src/shared/types/message.js";

describe("message timeline helpers", () => {
  it("sorts newest messages first while keeping sequence numbers increasing with time", () => {
    const records = getVisibleMessageRecords([
      message("msg_1", "2026-06-02T00:00:01.000Z"),
      message("msg_2", "2026-06-02T00:00:02.000Z", {
        acceptedAt: "2026-06-02T00:00:05.000Z"
      }),
      message("msg_3", "2026-06-02T00:00:03.000Z", {
        deliveredAt: "2026-06-02T00:00:04.000Z"
      }),
      message("msg_4", "2026-06-02T00:00:03.500Z", {
        dispatchingAt: "2026-06-02T00:00:04.500Z"
      })
    ], null);

    expect(records.map((record) => record.message.id)).toEqual(["msg_2", "msg_4", "msg_3", "msg_1"]);
    expect(records.map((record) => record.sequence)).toEqual([4, 3, 2, 1]);
  });

  it("counts message history without status lifecycle fields", () => {
    expect(getMessageCounts([
      message("msg_1", "2026-06-02T00:00:01.000Z", {
        deliveredAt: "2026-06-02T00:00:02.000Z",
        acceptedAt: "2026-06-02T00:00:03.000Z"
      }),
      message("msg_2", "2026-06-02T00:00:04.000Z", {
        deliveredAt: "2026-06-02T00:00:05.000Z"
      })
    ])).toEqual({
      total: 2,
      accepted: 1,
      delivered: 2
    });
  });
});

function message(
  id: string,
  createdAt: string,
  overrides: Partial<VcmRoleMessage> = {}
): VcmRoleMessage {
  return {
    id,
    taskSlug: "demo-task",
    fromRole: "project-manager",
    toRole: "coder",
    type: "task",
    body: "Do the work.",
    artifactRefs: [],
    createdAt,
    ...overrides
  };
}
