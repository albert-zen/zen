/** Host-only capture payload. JSON tool results never serialize this symbol. */
export const OBSERVATION_CAPTURE = Symbol("zenx.observation.capture");

export interface ObservationCoverage {
  /** Exact domain that was captured; never implies the complete desktop/page. */
  scope: string;
  sourceComplete: boolean | null;
  reasons: string[];
  itemTotal?: number;
  textTotal?: number;
}

export interface ObservationCapture<T> {
  /** Backend-owned document/window incarnation, independent of action revision. */
  scopeKey: string;
  entries: Array<{ value: T; identity?: string }>;
  text?: string;
  coverage: ObservationCoverage;
  /** Rejects consumed/replaced captures without silently taking a fresh one. */
  assertCurrent?: (signal?: AbortSignal) => void | Promise<void>;
}

export const MAX_OBSERVATION_CAPTURE_TEXT = 128_000;
export const MAX_OBSERVATION_CAPTURE_ITEMS = 512;
