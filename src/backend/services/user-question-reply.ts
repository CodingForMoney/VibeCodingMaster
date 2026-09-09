import type { WorkflowControlState, WorkflowUserQuestionReply } from "../../shared/types/workflow.js";

// Use the recorded turn window, not the current wait flag: replies must survive
// the user's answer and transcript replay without becoming a second message.
export function findUserQuestionReply(
  state: WorkflowControlState,
  sessionId: string,
  timestamp: string
): WorkflowUserQuestionReply | undefined {
  return state.userQuestionReplies?.slice().reverse().find((reply) => reply.sessionId === sessionId
    && timestamp >= reply.turnStartedAt && timestamp <= reply.completedAt);
}

export function isPendingUserQuestion(state: WorkflowControlState, timestamp: string): boolean {
  return Boolean(state.awaitingUser && timestamp >= state.awaitingUser.requestedAt
    && !state.userQuestionReplies?.some((reply) => reply.requestedAt === state.awaitingUser?.requestedAt));
}
