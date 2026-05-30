import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { TranslationWsMessage } from "../../shared/types/translation.js";
import { toVcmError } from "../errors.js";
import type { TranslationService } from "../services/translation-service.js";

export interface TranslationWsDeps {
  translationService: TranslationService;
}

export function registerTranslationWs(app: FastifyInstance, deps: TranslationWsDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/ws\/translation\/([^/]+)$/.exec(url.pathname);

    if (!match) {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      bindTranslationSocket(ws, decodeURIComponent(match[1] ?? ""), deps.translationService);
    });
  });
}

function bindTranslationSocket(ws: WebSocket, sessionId: string, translationService: TranslationService): void {
  let unsubscribe = () => {};

  try {
    unsubscribe = translationService.subscribeToSession(sessionId, (message) => send(ws, message));
  } catch (error) {
    const vcmError = toVcmError(error);
    send(ws, { type: "translation-error", message: vcmError.message });
    ws.close();
    return;
  }

  ws.on("close", () => {
    unsubscribe();
  });
}

function send(ws: WebSocket, message: TranslationWsMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

