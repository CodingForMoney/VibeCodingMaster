export interface RuntimeDiagnostics {
  version: string;
  pid: number;
  cwd: string;
  execPath: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  fdCount: number | null;
  openFilesLimit: OpenFilesLimit | null;
  runtimeSessions: RuntimeSessionDiagnostics;
  gateway: GatewayDiagnostics;
  translation: TranslationDiagnostics;
}

export interface OpenFilesLimit {
  soft: string;
  hard: string;
}

export interface RuntimeSessionDiagnostics {
  total: number;
  running: number;
}

export interface GatewayDiagnostics {
  polling: boolean;
}

export interface TranslationDiagnostics {
  sessions: number;
  transcriptWatchers: number;
  listeners: number;
}

/** How VCM handled one received Claude Code hook event. */
export interface HookEventDiagnostic {
  receivedAt: string;
  taskSlug: string;
  role: string;
  /** Hook event name, or `StaleActivityReconcile` for a VCM-side settlement. */
  eventName: string;
  /** Whether the event matched the role's current session, when VCM checked. */
  sessionMatched?: boolean;
  outcome: string;
  /** StopFailure error or last assistant message excerpt. */
  detail?: string;
  error?: string;
}

export interface HookEventDiagnostics {
  /** Newest first. */
  events: HookEventDiagnostic[];
}
