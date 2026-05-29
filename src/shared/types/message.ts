import type { RoleName } from "./role.js";

export type VcmMessageActor = RoleName | "user";

export type VcmMessageType =
  | "user-request"
  | "task"
  | "question"
  | "blocked"
  | "result"
  | "finding"
  | "review-request"
  | "revise"
  | "cancel";

export type VcmMessageStatus =
  | "pending_approval"
  | "queued"
  | "staged"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "rejected"
  | "cancelled";

export type VcmOrchestrationMode = "manual" | "auto";

export interface VcmRoleMessage {
  id: string;
  taskSlug: string;
  fromRole: VcmMessageActor;
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs: string[];
  bodyPath?: string;
  parentMessageId?: string;
  status: VcmMessageStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  stagedAt?: string;
  failureReason?: string;
}

export interface VcmOrchestrationState {
  taskSlug: string;
  mode: VcmOrchestrationMode;
  paused: boolean;
  updatedAt: string;
}

export interface SendRoleMessageRequest {
  fromRole: VcmMessageActor;
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs?: string[];
  parentMessageId?: string;
}

export interface SendRoleMessageResult {
  message: VcmRoleMessage;
  delivered: boolean;
  requiresUserApproval: boolean;
}
