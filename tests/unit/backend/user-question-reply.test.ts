import { describe, expect, it } from "vitest";
import type { WorkflowControlState } from "../../../src/shared/types/workflow.js";
import { findUserQuestionReply, isPendingUserQuestion } from "../../../src/backend/services/user-question-reply.js";

const reply = { id: "question-1", sessionId: "pm-1", question: "Choose A or B.",
  requestedAt: "2026-09-09T00:00:01.000Z", turnStartedAt: "2026-09-09T00:00:00.000Z", completedAt: "2026-09-09T00:00:02.000Z" };
const state: WorkflowControlState = { version: 1, taskSlug: "test", awaitingUser: reply,
  userQuestionReplies: [reply], pendingDispatch: null, activeDispatch: null, flowRun: null,
  userAuthorizations: [], userApprovedFollowUps: [], warnings: [], updatedAt: reply.completedAt };

describe("registered question reply selection", () => {
  it("replaces only the completed PM turn, including replay after the answer", () => {
    expect(findUserQuestionReply({ ...state, awaitingUser: null }, "pm-1", reply.completedAt)).toEqual(reply);
    expect(findUserQuestionReply(state, "architect-1", reply.completedAt)).toBeUndefined();
    expect(findUserQuestionReply(state, "pm-2", reply.completedAt)).toBeUndefined();
    expect(findUserQuestionReply(state, "pm-1", "2026-09-08T23:59:59.000Z")).toBeUndefined();
    expect(findUserQuestionReply(state, "pm-1", "2026-09-09T00:00:03.000Z")).toBeUndefined();
  });

  it("withholds a transcript final only while its registered question awaits Stop", () => {
    const waiting = { ...state, userQuestionReplies: [] };
    expect(isPendingUserQuestion(waiting, reply.completedAt)).toBe(true);
    expect(isPendingUserQuestion(waiting, reply.turnStartedAt)).toBe(false);
    expect(isPendingUserQuestion(state, reply.completedAt)).toBe(false);
    expect(isPendingUserQuestion({ ...waiting, awaitingUser: null }, reply.completedAt)).toBe(false);
  });
});
