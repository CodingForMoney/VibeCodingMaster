export type ArchitectRestartStatus = "pending" | "executing" | "blocked";

export interface ArchitectRestartBlocker {
  code: string;
  message: string;
  blockedAt: string;
}

export interface ArchitectRestartState {
  taskSlug: string;
  sessionId: string;
  status: ArchitectRestartStatus;
  memoryCandidatePath?: string;
  blocker?: ArchitectRestartBlocker;
}
