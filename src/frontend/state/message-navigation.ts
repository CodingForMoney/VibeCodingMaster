import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";

export function selectAutoDispatchRole(
  previousMessages: VcmRoleMessage[] | null,
  nextMessages: VcmRoleMessage[],
  orchestration: VcmOrchestrationState
): RoleName | null {
  if (!previousMessages || orchestration.mode !== "auto") {
    return null;
  }

  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  const newlyDispatching = nextMessages.filter((message) => {
    if (!message.dispatchingAt) {
      return false;
    }
    return previousById.get(message.id)?.dispatchingAt !== message.dispatchingAt;
  });
  if (newlyDispatching.length === 0) {
    return null;
  }

  return newlyDispatching.sort(compareDispatchingMessages)[newlyDispatching.length - 1]?.toRole ?? null;
}

function compareDispatchingMessages(left: VcmRoleMessage, right: VcmRoleMessage): number {
  const leftDispatchingAt = left.dispatchingAt ?? left.deliveredAt ?? left.acceptedAt ?? "";
  const rightDispatchingAt = right.dispatchingAt ?? right.deliveredAt ?? right.acceptedAt ?? "";
  if (leftDispatchingAt !== rightDispatchingAt) {
    return leftDispatchingAt.localeCompare(rightDispatchingAt);
  }

  return left.createdAt.localeCompare(right.createdAt);
}
