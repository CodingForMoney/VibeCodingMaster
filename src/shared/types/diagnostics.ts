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
