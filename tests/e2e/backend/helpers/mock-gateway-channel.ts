import type {
  GatewayChannelAdapter,
  GatewayGetUpdatesInput,
  GatewayInboundMessage,
  GatewaySendTextInput
} from "../../../../src/backend/gateway/gateway-channel.js";

interface PendingPoll {
  resolve(result: { cursor: string; updates: GatewayInboundMessage[] }): void;
  abort(): void;
}

export interface MockGatewaySentText {
  toUserId: string;
  chatId?: string;
  contextToken?: string;
  text: string;
}

export interface EnqueueGatewayTextOptions {
  messageId?: string;
  fromUserId?: string;
  chatId?: string;
  contextToken?: string;
  createdAt?: string;
}

export class MockGatewayChannel implements GatewayChannelAdapter {
  readonly id = "lark";
  readonly label = "Mock Gateway";
  readonly defaultBaseUrl = "mock://gateway";
  private readonly queue: GatewayInboundMessage[] = [];
  private readonly pendingPolls: PendingPoll[] = [];
  private readonly sent: MockGatewaySentText[] = [];
  private messageSeq = 0;
  private cursorSeq = 0;
  private updateCalls = 0;

  get getUpdatesCalls(): number {
    return this.updateCalls;
  }

  get sentTexts(): readonly MockGatewaySentText[] {
    return this.sent;
  }

  enqueueText(text: string, options: EnqueueGatewayTextOptions = {}): GatewayInboundMessage {
    const update: GatewayInboundMessage = {
      messageId: options.messageId ?? `mock-gateway-message-${++this.messageSeq}`,
      fromUserId: options.fromUserId ?? "mock-user",
      chatId: options.chatId ?? "mock-chat",
      chatType: "dm",
      contextToken: options.contextToken,
      createdAt: options.createdAt ?? new Date().toISOString(),
      text
    };
    this.queue.push(update);
    this.flushPendingPoll();
    return update;
  }

  async getUpdates(input: GatewayGetUpdatesInput) {
    this.updateCalls += 1;
    if (input.timeoutMs === 1) {
      return this.takeQueuedUpdates();
    }
    if (this.queue.length > 0) {
      return this.takeQueuedUpdates();
    }
    return new Promise<{ cursor: string; updates: GatewayInboundMessage[] }>((resolve) => {
      const pending: PendingPoll = {
        resolve,
        abort: () => {
          this.removePending(pending);
          resolve(this.takeQueuedUpdates());
        }
      };
      this.pendingPolls.push(pending);
      input.signal?.addEventListener("abort", pending.abort, { once: true });
    });
  }

  async sendText(input: GatewaySendTextInput): Promise<string> {
    this.sent.push({
      toUserId: input.toUserId,
      chatId: input.chatId,
      contextToken: input.contextToken,
      text: input.text
    });
    return `mock-gateway-sent-${this.sent.length}`;
  }

  clear(): void {
    this.queue.length = 0;
    this.sent.length = 0;
  }

  private flushPendingPoll(): void {
    const pending = this.pendingPolls.shift();
    if (!pending) {
      return;
    }
    pending.resolve(this.takeQueuedUpdates());
  }

  private removePending(pending: PendingPoll): void {
    const index = this.pendingPolls.indexOf(pending);
    if (index >= 0) {
      this.pendingPolls.splice(index, 1);
    }
  }

  private takeQueuedUpdates(): { cursor: string; updates: GatewayInboundMessage[] } {
    const updates = this.queue.splice(0);
    return {
      cursor: `mock-cursor-${++this.cursorSeq}`,
      updates
    };
  }
}
