import type { RoleName, RoleStatus } from "../../shared/types/role.js";
import type { TerminalEvent } from "../../shared/types/terminal.js";

export interface CreateTerminalSessionInput {
  taskSlug: string;
  role: RoleName;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  logPath: string;
}

export interface TerminalSession {
  id: string;
  taskSlug: string;
  role: RoleName;
  status: RoleStatus;
  pid?: number;
  startedAt: string;
  lastOutputAt?: string;
  exitCode?: number | null;
}

export type TerminalEventListener = (event: TerminalEvent) => void;
export type Unsubscribe = () => void;

export interface SubscribeTerminalOptions {
  replay?: boolean;
}

export interface TerminalRuntime {
  createSession(input: CreateTerminalSessionInput): Promise<TerminalSession>;
  getSession(sessionId: string): TerminalSession | undefined;
  getSessionByRole(taskSlug: string, role: RoleName): TerminalSession | undefined;
  listSessions(taskSlug?: string): TerminalSession[];
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  stop(sessionId: string): Promise<void>;
  restart(sessionId: string): Promise<TerminalSession>;
  subscribe(sessionId: string, listener: TerminalEventListener, options?: SubscribeTerminalOptions): Unsubscribe;
}
