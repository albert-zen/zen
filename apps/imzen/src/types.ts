export type QQConversationKind = 'c2c' | 'group';

export type QQInboundMessage = {
  readonly conversationId: string;
  readonly kind: QQConversationKind;
  readonly messageId: string;
  readonly receivedAtMs: number;
  readonly text: string;
  readonly userId: string;
};

export type QQOutboundMessage = {
  readonly conversationId: string;
  readonly deliveryId: string;
  readonly receivedAtMs: number;
  readonly replyToMessageId: string;
  readonly text: string;
};

export type ConversationBinding = {
  readonly projectId: string;
  readonly threadId: string;
};

export type PendingInboundJob = QQInboundMessage & {
  readonly attempts: number;
  readonly enqueuedAtMs: number;
  readonly lastError?: string;
  readonly turnId?: string;
};
