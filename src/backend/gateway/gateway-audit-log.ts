import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface GatewayAuditLog {
  record(input: GatewayAuditEvent): Promise<void>;
}

export interface GatewayAuditEvent {
  type: string;
  result?: "ok" | "ignored" | "error";
  messageId?: string;
  userId?: string;
  command?: string;
  preview?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayAuditLogDeps {
  fs: FileSystemAdapter;
  auditPath: string;
  now?: () => string;
}

export function createGatewayAuditLog(deps: GatewayAuditLogDeps): GatewayAuditLog {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async record(input) {
      await deps.fs.appendText(deps.auditPath, `${JSON.stringify(redactEvent({
        ...input,
        createdAt: now()
      }))}\n`);
    }
  };
}

function redactEvent(input: GatewayAuditEvent & { createdAt: string }): GatewayAuditEvent & { createdAt: string } {
  return {
    ...input,
    preview: input.preview ? input.preview.slice(0, 160) : undefined,
    error: input.error ? redactSecrets(input.error).slice(0, 500) : undefined,
    metadata: input.metadata ? redactObject(input.metadata) : undefined
  };
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|authorization|qrcode|secret|apiKey/i.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string") {
      out[key] = redactSecrets(value).slice(0, 500);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/bot_token["'\s:=]+[A-Za-z0-9._-]+/gi, "bot_token=[redacted]");
}
