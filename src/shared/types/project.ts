import type { RoleName } from "./role.js";

export interface ProjectConfig {
  version: 1;
  repoRoot: string;
  defaultRoles: RoleName[];
  handoffRoot: string;
  stateRoot: string;
  terminalBackend: "node-pty";
  claudeCommand: string;
}

export interface ProjectSummary {
  repoRoot: string;
  branch: string;
  isDirty: boolean;
  config: ProjectConfig;
  warnings: string[];
}

export interface ConnectProjectRequest {
  repoPath: string;
}
