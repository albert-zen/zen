import type { CanonicalItem } from "./item.js";

/** Foreign call representation, retained only as inert historical provenance. */
export interface ImportedToolCallOrigin {
  inputFormat: "json" | "text";
  namespace?: string;
}

/** Immutable source attribution, never an execution configuration or resume token. */
export interface ThreadImportSource {
  format: string;
  sourceId: string;
  sourceVersion: string;
  sourceProvider?: string;
  sourceModel?: string;
  sourceCwd: string;
  sha256: string;
  exclusions: string[];
  contextBasis?: {
    kind: "replacement-history" | "summary-checkpoint";
    sourceLine: number;
    earlierRecords: number;
  };
}
export interface ThreadImportOrigin extends ThreadImportSource {
  /** Number of original history Items after metadata, including the import notice. */
  historyItemCount: number;
}
type HistoryItem = Extract<
  CanonicalItem,
  {
    type:
      | "user_message"
      | "agent_message"
      | "reasoning"
      | "tool_call"
      | "tool_result";
  }
>;
type StripIdentity<T> = T extends HistoryItem
  ? Omit<T, "id" | "threadId" | "turnId">
  : never;
export type ImportedHistoryItem = StripIdentity<HistoryItem>;
export interface ThreadImportHistory {
  source: ThreadImportSource;
  turns: {
    createdAt: string;
    endedAt: string;
    status: "completed" | "interrupted";
    items: ImportedHistoryItem[];
  }[];
}
export const IMPORTED_TOOL_RESULT_CONTENT_TYPE = "zen.imported-tool-result.v1";
export const MAX_THREAD_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_THREAD_IMPORT_RECORDS = 20_000;
