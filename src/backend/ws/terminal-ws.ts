import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type {
  ClientTerminalMessage,
  ServerTerminalMessage
} from "../../shared/types/terminal.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { toVcmError } from "../errors.js";

export interface TerminalWsDeps {
  runtime: TerminalRuntime;
}

export function registerTerminalWs(app: FastifyInstance, deps: TerminalWsDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/ws\/terminal\/([^/]+)$/.exec(url.pathname);

    if (!match) {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      bindTerminalSocket(ws, decodeURIComponent(match[1] ?? ""), deps.runtime);
    });
  });
}

function bindTerminalSocket(ws: WebSocket, sessionId: string, runtime: TerminalRuntime): void {
  let unsubscribe = () => {};

  try {
    unsubscribe = runtime.subscribe(sessionId, (event) => {
      if (event.type === "output") {
        send(ws, { type: "output", data: event.data ?? "" });
      } else if (event.type === "exit") {
        send(ws, { type: "exit", exitCode: event.exitCode ?? null });
      } else if (event.type === "status" && event.status) {
        send(ws, { type: "status", status: event.status });
      }
    });
  } catch (error) {
    const vcmError = toVcmError(error);
    send(ws, { type: "error", message: vcmError.message });
    ws.close();
    return;
  }

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as ClientTerminalMessage;
      if (message.type === "input") {
        runtime.write(sessionId, message.data);
      } else if (message.type === "resize") {
        if (isSafeTerminalResize(message.cols, message.rows)) {
          runtime.resize(sessionId, message.cols, message.rows);
        }
      }
    } catch (error) {
      const vcmError = toVcmError(error);
      send(ws, { type: "error", message: vcmError.message });
    }
  });

  ws.on("close", () => {
    unsubscribe();
  });
}

export function isSafeTerminalResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_TERMINAL_COLS &&
    rows >= MIN_TERMINAL_ROWS &&
    cols <= MAX_TERMINAL_COLS &&
    rows <= MAX_TERMINAL_ROWS
  );
}

const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_COLS = 1000;
const MAX_TERMINAL_ROWS = 200;

function send(ws: WebSocket, message: ServerTerminalMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
