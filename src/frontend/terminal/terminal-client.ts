import type {
  ClientTerminalMessage,
  ServerTerminalMessage
} from "../../shared/types/terminal.js";
import { errorReason } from "../state/error-format.js";

export interface TerminalClientHandlers {
  onOutput(data: string): void;
  onStatus?(message: ServerTerminalMessage): void;
  onError?(message: string): void;
}

export class TerminalClient {
  private socket: WebSocket;

  constructor(sessionId: string, handlers: TerminalClientHandlers) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const terminalUrl = `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(sessionId)}`;
    this.socket = new WebSocket(terminalUrl);

    this.socket.addEventListener("message", (event) => {
      let message: ServerTerminalMessage;
      try {
        message = JSON.parse(event.data as string) as ServerTerminalMessage;
      } catch (error) {
        handlers.onError?.(`Terminal message parse failed for session ${sessionId}. Reason: ${errorReason(error)}`);
        return;
      }
      if (message.type === "output") {
        handlers.onOutput(message.data);
      } else if (message.type === "error") {
        handlers.onError?.(message.message);
      } else {
        handlers.onStatus?.(message);
      }
    });

    this.socket.addEventListener("error", () => {
      handlers.onError?.(`Terminal WebSocket connection failed for session ${sessionId}. URL: ${terminalUrl}. Check that the VCM backend is running and the session still exists.`);
    });
  }

  sendInput(data: string): void {
    this.send({ type: "input", data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  close(): void {
    this.socket.close();
  }

  private send(message: ClientTerminalMessage): void {
    const payload = JSON.stringify(message);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
      return;
    }

    this.socket.addEventListener("open", () => this.socket.send(payload), { once: true });
  }
}
