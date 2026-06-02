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
  routePath?: string;
  parentMessageId?: string;
  createdAt: string;
  dispatchingAt?: string;
  deliveredAt?: string;
  acceptedAt?: string;
  failureReason?: string;
}

export interface VcmOrchestrationState {
  taskSlug: string;
  mode: VcmOrchestrationMode;
  updatedAt: string;
}

export interface VcmRouteFile {
  path: string;
  fromRole: RoleName;
  toRole: RoleName;
  type: VcmMessageType;
  body: string;
  artifactRefs: string[];
  exists: boolean;
  pending: boolean;
  updatedAt?: string;
}

export interface VcmRouteFileDispatchResult {
  message?: VcmRoleMessage;
  delivered: boolean;
  requiresUserApproval: boolean;
  clearedRouteFile: boolean;
  failureReason?: string;
}

export interface MarkAllMessagesDoneResult {
  taskSlug: string;
  updatedCount: number;
  messages: VcmRoleMessage[];
}

export interface DeleteMessageHistoryResult {
  taskSlug: string;
  deletedCount: number;
  messages: VcmRoleMessage[];
}
