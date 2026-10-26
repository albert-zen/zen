/** Ephemeral Host observations; never a source of conversation or execution state. */
export interface ModelRequestDebugSummary {
  id: string;
  capturedAt: string;
  threadId: string;
  purpose: "turn" | "compaction" | "operation";
  turnId: string | null;
  sampleId: string;
  contextBoundaryItemId: string;
  sampleAttempt: number;
  transportAttempt: number;
  provider: string;
  model: string;
  format: "chat-completions" | "responses" | "model-input";
  redacted: boolean;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
  sourceAttachments: Array<{
    sha256: string;
    mediaType: string;
    byteLength: number;
    width?: number;
    height?: number;
  }>;
  sourceAttachmentCount: number;
}
export type ModelRequestDebugView =
  "payload" | "messages" | "tools" | "configuration";
export type ModelRequestDebugCommand =
  | { action: "status" }
  | { action: "setEnabled"; enabled: boolean }
  | { action: "clear" }
  | { action: "list"; threadId: string; query?: string }
  | {
      action: "read";
      id: string;
      offset?: number;
      view?: ModelRequestDebugView;
    };
export interface ModelRequestDebugResult {
  sessionId: string;
  generation: number;
  enabled: boolean;
  retainedCount: number;
  retainedBytes: number;
  evictedCount: number;
  limits: {
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
    pageCharacters: number;
  };
  records?: ModelRequestDebugSummary[];
  page?: {
    record: ModelRequestDebugSummary;
    view: ModelRequestDebugView;
    text: string;
    offset: number;
    nextOffset: number | null;
    totalCharacters: number;
  };
}
