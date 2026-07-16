import type { Item } from "../kernel/index.js";

export type ThreadJournalReplay =
  | { readonly type: "success"; readonly threadId: string; readonly path: string; readonly items: readonly Item[] }
  | { readonly type: "failure"; readonly path: string; readonly threadId?: string; readonly error: ThreadJournalCorruptionError };

export interface ThreadJournal {
  create(threadId: string, item: Item): Promise<void>;
  append(threadId: string, item: Item): Promise<void>;
  flush(threadId: string): Promise<void>;
  replay(): Promise<readonly ThreadJournalReplay[]>;
  close(): Promise<void>;
}

export class ThreadJournalError extends Error {
  constructor(
    readonly threadId: string,
    readonly operation: "create" | "append" | "flush" | "close",
    cause: unknown
  ) {
    super(`Thread journal ${operation} failed for ${threadId}: ${readMessage(cause)}`, { cause });
    this.name = "ThreadJournalError";
  }
}

export class ThreadJournalCorruptionError extends Error {
  constructor(readonly path: string, readonly recordNumber: number, message: string) {
    super(`Thread journal corruption at ${path}, record ${recordNumber}: ${message}`);
    this.name = "ThreadJournalCorruptionError";
  }
}

function readMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
