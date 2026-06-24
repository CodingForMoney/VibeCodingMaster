import fs from "node:fs/promises";
import type { RuntimeDiagnostics, OpenFilesLimit } from "../../shared/types/diagnostics.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { TranslationService } from "./translation-service.js";
import { readVcmPackageVersion } from "../app-version.js";

export interface DiagnosticsService {
  getRuntimeDiagnostics(): Promise<RuntimeDiagnostics>;
  getErrorRuntimeInfo(): ErrorRuntimeInfo;
}

export interface ErrorRuntimeInfo {
  version: string;
  pid: number;
  cwd: string;
}

export interface DiagnosticsServiceDeps {
  appRoot: string;
  runtime: Pick<TerminalRuntime, "listSessions">;
  gatewayService: Pick<GatewayService, "getDiagnostics">;
  translationService: Pick<TranslationService, "getDiagnostics">;
}

export function createDiagnosticsService(deps: DiagnosticsServiceDeps): DiagnosticsService {
  const version = readVcmPackageVersion(deps.appRoot);

  return {
    async getRuntimeDiagnostics() {
      const runtimeSessions = deps.runtime.listSessions();
      return {
        version,
        pid: process.pid,
        cwd: process.cwd(),
        execPath: process.execPath,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
        fdCount: await readFdCount(),
        openFilesLimit: await readOpenFilesLimit(),
        runtimeSessions: {
          total: runtimeSessions.length,
          running: runtimeSessions.filter((session) => session.status === "running").length
        },
        gateway: deps.gatewayService.getDiagnostics(),
        translation: deps.translationService.getDiagnostics()
      };
    },
    getErrorRuntimeInfo() {
      return {
        version,
        pid: process.pid,
        cwd: process.cwd()
      };
    }
  };
}

async function readFdCount(): Promise<number | null> {
  try {
    return (await fs.readdir("/proc/self/fd")).length;
  } catch {
    return null;
  }
}

async function readOpenFilesLimit(): Promise<OpenFilesLimit | null> {
  try {
    const limits = await fs.readFile("/proc/self/limits", "utf8");
    const line = limits.split("\n").find((candidate) => candidate.startsWith("Max open files"));
    if (!line) {
      return null;
    }
    const match = line.match(/^Max open files\s+(\S+)\s+(\S+)/);
    if (!match) {
      return null;
    }
    return {
      soft: match[1] ?? "unknown",
      hard: match[2] ?? "unknown"
    };
  } catch {
    return null;
  }
}
