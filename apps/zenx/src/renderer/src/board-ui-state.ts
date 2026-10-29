import { localErrorDetail } from "../../local-error-detail.js";
import type {
  BoardEventResult,
  BoardOwner,
  BoardSnapshot,
  BoardValues,
} from "../../../../../packages/zenx-board-plugin/src/board.js";
export type BoardConversation =
  { kind: "thread"; threadId: string } | { kind: "room"; roomId: string };
/** Unsent window-local drafts survive popup/rail/owner remounts; durable writes stay in plugin storage. */
export class BoardUiSession {
  snapshot: BoardSnapshot | null = null;
  values: BoardValues = {};
  error: string | null = null;
  /** Transient owner-readable diagnostics; never part of a saved draft. */
  errorDetail: string | null = null;
  result: BoardEventResult | null = null;
  dirty = false;
  busy = false;
  loading = true;
  #edit = 0;
  #readError = false;
  #read = 0;
  #saving: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<() => void>();
  constructor(
    readonly owner: BoardConversation,
    readonly command: (input: Record<string, unknown>) => Promise<unknown>,
  ) {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  #clearError() {
    this.error = null;
    this.errorDetail = null;
    this.#readError = false;
  }
  #fail(error: unknown) {
    this.error = message(error);
    this.errorDetail = localErrorDetail(error);
  }
  async refresh() {
    const read = ++this.#read;
    try {
      const next = (await this.command({
        operation: "read",
        owner: this.owner,
      })) as BoardSnapshot | null;
      if (read !== this.#read) return;
      if (this.#readError) this.#clearError();
      if (
        next &&
        (!this.snapshot ||
          (next.revision >= this.snapshot.revision &&
            next.draftRevision >= this.snapshot.draftRevision))
      ) {
        if (!this.dirty) {
          this.values = { ...next.values };
          this.snapshot = next;
        } else if (
          !this.snapshot ||
          next.draftRevision === this.snapshot.draftRevision
        ) {
          this.snapshot = next;
        } else {
          this.error =
            "The saved draft changed in another view. Your local fields are kept; reload or copy them before continuing.";
          this.errorDetail = null;
        }
      } else if (!next && !this.dirty) this.snapshot = null;
    } catch (error) {
      if (read === this.#read) {
        this.#fail(error);
        this.#readError = true;
      }
    } finally {
      if (read === this.#read) {
        this.loading = false;
        this.#emit();
      }
    }
  }
  edit(values: BoardValues) {
    this.values = { ...this.values, ...values };
    this.#edit++;
    this.#read++;
    this.dirty = true;
    this.#clearError();
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 350);
    this.#emit();
  }
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    if (this.#saving) {
      await this.#saving;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty || !this.snapshot) return;
    const edit = this.#edit;
    const sent = { ...this.values };
    const snapshot = this.snapshot;
    this.#saving = (async () => {
      try {
        const next = (await this.command({
          operation: "draft",
          owner: snapshot.document.owner,
          expectedDraftRevision: snapshot.draftRevision,
          values: sent,
        })) as BoardSnapshot;
        this.#read++;
        this.snapshot =
          this.snapshot && this.snapshot.revision > next.revision
            ? {
                ...next,
                document: this.snapshot.document,
                revision: this.snapshot.revision,
              }
            : next;
        if (this.#edit === edit) {
          this.values = { ...next.values };
          this.dirty = false;
        }
        this.#clearError();
      } catch (error) {
        this.#readError = false;
        this.#fail(error);
        throw error;
      } finally {
        this.#saving = null;
        this.#emit();
      }
    })();
    return this.#saving;
  }
  async run(eventId: string, values?: BoardValues): Promise<BoardEventResult> {
    if (this.busy) throw new Error("A Board action is already running");
    const clicked = this.snapshot;
    if (!clicked) throw new Error("No Board exists");
    this.busy = true;
    this.result = null;
    this.#clearError();
    this.#emit();
    try {
      await this.flush();
      if (
        !this.snapshot ||
        this.snapshot.revision !== clicked.revision ||
        this.snapshot.document.id !== clicked.document.id ||
        JSON.stringify(this.snapshot.document.owner) !==
          JSON.stringify(clicked.document.owner)
      )
        throw new Error(
          "Board changed while saving your fields; review the action and click again",
        );
      const current = this.snapshot;
      const edit = this.#edit;
      const result = (await this.command({
        operation: "event",
        owner: current.document.owner,
        eventId,
        values,
        revision: current.revision,
        draftRevision: current.draftRevision,
      })) as BoardEventResult;
      // A poll begun before this receipt cannot subsequently roll its state back.
      this.#read++;
      this.result = result;
      this.error = result.error ?? null;
      this.errorDetail = result.error ? (result.errorDetail ?? null) : null;
      this.#readError = false;
      if (
        this.#edit === edit &&
        !this.dirty &&
        result.snapshot.revision >= (this.snapshot?.revision ?? 0) &&
        result.snapshot.draftRevision >= (this.snapshot?.draftRevision ?? 0)
      ) {
        this.snapshot = result.snapshot;
        this.values = { ...result.snapshot.values };
      }
      return result;
    } catch (error) {
      this.#readError = false;
      this.#fail(error);
      throw error;
    } finally {
      this.busy = false;
      this.#emit();
    }
  }
  async discardLocalDraft() {
    clearTimeout(this.#timer);
    const edit = this.#edit;
    try {
      await this.#saving;
    } catch {
      /* The explicit discard does not retry a failed save. */
    }
    if (this.#edit !== edit)
      throw new Error(
        "Newer local typing was preserved; discard again if intended",
      );
    this.dirty = false;
    this.#clearError();
    await this.refresh();
  }
  async pin(pinned: boolean) {
    if (!this.snapshot) return;
    const next = (await this.command({
      operation: "pin",
      owner: this.snapshot.document.owner,
      pinned,
    })) as BoardSnapshot;
    this.snapshot = { ...this.snapshot, pinned: next.pinned };
    this.#emit();
  }
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function conversationKey(owner: BoardConversation | BoardOwner) {
  return owner.kind === "thread"
    ? `thread:${owner.threadId}`
    : `room:${owner.roomId}`;
}
