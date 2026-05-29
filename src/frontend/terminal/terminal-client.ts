import type {
  ClientTerminalMessage,
  ServerTerminalMessage
} from "../../shared/types/terminal.js";

export interface TerminalClientHandlers {
  onOutput(data: string): void;
  onStatus?(message: ServerTerminalMessage): void;
  onError?(message: string): void;
}

export class TerminalClient {
  private socket: WebSocket;

  constructor(sessionId: string, handlers: TerminalClientHandlers) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(sessionId)}`);

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerTerminalMessage;
      if (message.type === "output") {
        handlers.onOutput(message.data);
      } else if (message.type === "error") {
        handlers.onError?.(message.message);
      } else {
        handlers.onStatus?.(message);
      }
    });

    this.socket.addEventListener("error", () => {
      handlers.onError?.("Terminal connection failed.");
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
