/** Read-only views of durable evidence. None of these objects authorizes execution. */
export type ModelRequestDebugView =
  | "payload"
  | "messages"
  | "tools"
  | "configuration"
  | "output"
  | "timeline"
  | "artifact";
export type ModelRequestDebugCommand =
  | { action: "status" }
  | {
      action: "list";
      threadId: string;
      query?: string;
      mode?: "requests" | "events";
      offset?: number;
    }
  | {
      action: "read";
      threadId: string;
      id: string;
      offset?: number;
      view?: ModelRequestDebugView;
      artifactIndex?: number;
    };
export interface ModelRequestDebugSummary {
  id: string;
  threadId: string;
  capturedAt: string;
  type: string;
  turnId: string | null;
  sampleId: string | null;
  purpose: string;
  provider: string;
  model: string;
  format: string;
  sampleAttempt: number | null;
  transportAttempt: number | null;
  toolMediaTransport?: import("../../../src/model/transport-types.js").ToolMediaTransportSummary;
  sampleOutcome:
    "completed" | "failed" | "cancelled" | "consumer_cancelled" | "unknown";
  dispatch: "observed" | "blocked" | "unknown" | "not-applicable";
  preparedRequestCaptured: boolean;
  responseCapture:
    | "complete"
    | "incomplete"
    | "interrupted"
    | "error"
    | "unknown"
    | "not-applicable";
  sampleDurationMs: number | null;
  attemptDurationMs: number | null;
  attemptTimingScope:
    "fetch-invocation-to-capture-end" | "request-preparation-to-block" | null;
  requestBytes: number | null;
  responseBytes: number;
  artifacts: Array<{
    name: string;
    byteLength: number;
    mediaType: string;
    captureLayer?: string;
  }>;
}
export interface ModelRequestDebugResult {
  durability: "healthy" | "degraded" | "unknown";
  completeness: "complete" | "incomplete" | "unavailable";
  /** Index verifies frames; payload artifacts are verified individually on read. */
  artifactVerification: "on-read";
  issues: Array<{
    kind: string;
    message: string;
    threadId?: string;
    recordId?: string;
  }>;
  limits: { pageCharacters: number; pageRecords: number };
  records?: ModelRequestDebugSummary[];
  totalRecords?: number;
  nextOffset?: number | null;
  page?: {
    record: ModelRequestDebugSummary;
    timeline?: TraceTimeline;
    view: ModelRequestDebugView;
    text: string;
    encoding: "utf8" | "base64";
    availability: "available" | "unavailable";
    offset: number;
    nextOffset: number | null;
    totalCharacters: number | null;
    offsetUnit?: "bytes" | "characters";
    endOffset?: number;
    totalBytes?: number;
  };
}

export interface TraceTimelinePoint {
  stage: string;
  clock: import("../../../src/trace.js").TraceClock | null;
  recordId: string | null;
  elapsedMs: number | null;
  elapsedFrom: string | null;
  outcome: string | null;
}
export interface TraceTimeline {
  inputs: Array<{
    requestId: string;
    clientId: string | null;
    activation: import("../../../src/trace.js").TraceClock | null;
    received: import("../../../src/trace.js").TraceClock | null;
    outcome: string;
  }>;
  stages: TraceTimelinePoint[];
}
