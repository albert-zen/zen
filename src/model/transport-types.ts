import type { TraceClock } from "../trace-clock.js";
/** Portable observation contracts. No Node or transport implementation imports. */
export type ModelDispatchRevocationReason =
  "provider_revoked" | "account_changed" | "auth_session_changed";
export interface ModelTransportError {
  name: string;
  message: string;
  stack?: string;
  /** Full diagnostic rendering of exposed cause/code/custom error fields. */
  details: string;
}
type Attempt = { transportAttempt: number };
/** Fetch-exposed input/body bytes, never TLS wire bytes or hidden provider state. */
export type ModelTransportObservation = Attempt &
  (
    | {
        type: "request";
        captureLayer: "fetch-request-input";
        url: string;
        method: string;
        headers: Array<[string, string]>;
        omittedHeaders: string[];
        body?: Uint8Array;
        completeness: "complete" | "unavailable";
        format: "chat-completions" | "responses" | "model-input";
        provider: string;
        model: string;
      }
    | {
        type: "capture_gap";
        captureLayer: "fetch-request-input";
        reason: "unsupported_body_type";
        bodyType: string;
        offset: 0;
      }
    | {
        type: "request_dispatched";
        captureLayer: "fetch-invocation";
        observedClock?: TraceClock;
      }
    | {
        type: "dispatch_blocked";
        captureLayer: "fetch-request-input";
        reason: ModelDispatchRevocationReason | "request_aborted";
        preparedRequestCaptured: boolean;
        error: ModelTransportError;
      }
    | {
        type: "response_headers";
        observedClock?: TraceClock;
        captureLayer: "fetch-response-body";
        status: number;
        statusText: string;
        headers: Array<[string, string]>;
      }
    | {
        type: "response_chunk";
        captureLayer: "fetch-response-body";
        index: number;
        offset: number;
        bytes: Uint8Array;
      }
    | {
        type: "response_drain_started";
        captureLayer: "fetch-response-body";
        reason: "provider_terminal_marker";
        offset: number;
      }
    | {
        type: "response_end";
        captureLayer: "fetch-response-body";
        completeness: "complete" | "interrupted";
        reason?: string;
        chunks: number;
        bytes: number;
        offset: number;
      }
    | {
        type: "transport_error";
        captureLayer: "fetch-request-input" | "fetch-response-body";
        offset: number;
        error: ModelTransportError;
      }
  );
export type ModelTransportObserver = (
  observation: ModelTransportObservation,
) => void | Promise<void>;
/** Host checks are synchronous: a successful check cannot outlive an awaited capture. */
export interface ModelTransportHooks {
  onTransport?: ModelTransportObserver;
  assertDispatchAllowed?: () => void;
}
