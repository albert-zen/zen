import { useEffect, useState } from "react";
import type { WorkspaceTextFile } from "../../main/workspace-files.js";
import type { WorkspaceFileSaveResult } from "../../main/workspace-files.js";

export interface WorkspaceFileDraft {
  base: WorkspaceTextFile;
  text: string;
  saving?: boolean;
  error?: string;
  conflict?: WorkspaceTextFile;
}
export const fileDraftKey = (threadId: string, path: string) =>
  JSON.stringify([threadId, path]);
export const isFileDirty = (draft: WorkspaceFileDraft) =>
  draft.text !== draft.base.text;
export type WorkspaceFileSaver = (
  text: string,
  revision: string,
) => Promise<WorkspaceFileSaveResult>;

// Window-owned UI state, shared across Thread panels, never written to the journal.
export class WorkspaceFileDrafts {
  #entries = new Map<string, WorkspaceFileDraft>();
  #listeners = new Set<() => void>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #saving = new Set<string>();
  #pending = new Set<string>();
  readonly #debounceMs: number;
  constructor(debounceMs = 500) {
    this.#debounceMs = debounceMs;
  }
  snapshot = () => this.#entries;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  set(key: string, value: WorkspaceFileDraft) {
    this.#entries = new Map(this.#entries).set(key, value);
    if (!isFileDirty(value)) this.#clearTimer(key);
    this.#emit();
  }
  edit(
    key: string,
    text: string,
    save: WorkspaceFileSaver,
    debounceMs = this.#debounceMs,
  ) {
    const current = this.#entries.get(key);
    if (current === undefined) return;
    this.set(key, {
      ...current,
      text,
      error: current.conflict ? current.error : undefined,
    });
    if (text === current.base.text || current.conflict) return;
    this.#schedule(key, save, debounceMs);
  }
  flush(key: string, save: WorkspaceFileSaver) {
    this.#clearTimer(key);
    void this.#save(key, save);
  }
  remove(key: string) {
    this.#clearTimer(key);
    this.#pending.delete(key);
    this.#entries = new Map(this.#entries);
    this.#entries.delete(key);
    this.#emit();
  }
  hasUnsaved = () =>
    [...this.#entries.values()].some(
      (draft) => isFileDirty(draft) || draft.saving,
    );

  #schedule(key: string, save: WorkspaceFileSaver, debounceMs: number) {
    this.#clearTimer(key);
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        void this.#save(key, save);
      }, debounceMs),
    );
  }

  async #save(key: string, save: WorkspaceFileSaver) {
    const draft = this.#entries.get(key);
    if (draft === undefined || !isFileDirty(draft) || draft.conflict) return;
    if (this.#saving.has(key)) {
      this.#pending.add(key);
      return;
    }
    this.#saving.add(key);
    const text = draft.text;
    const revision = draft.base.revision;
    this.set(key, {
      ...draft,
      saving: true,
      error: undefined,
    });
    try {
      const result = await save(text, revision);
      const current = this.#entries.get(key);
      if (current === undefined) return;
      if (result.status === "conflict") {
        this.set(key, {
          ...current,
          saving: false,
          conflict: result.file,
          error:
            "This file changed on disk. Your draft is kept. Compare the disk version or discard your draft and reload.",
        });
        this.#pending.delete(key);
        return;
      }
      this.set(key, {
        base: result.file,
        text: current.text,
        saving: false,
      });
    } catch (reason) {
      const current = this.#entries.get(key);
      if (current !== undefined)
        this.set(key, {
          ...current,
          saving: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      this.#pending.delete(key);
      return;
    } finally {
      this.#saving.delete(key);
    }
    const current = this.#entries.get(key);
    if (
      current !== undefined &&
      isFileDirty(current) &&
      (this.#pending.delete(key) || !this.#timers.has(key))
    ) {
      this.#schedule(key, save, 0);
    }
  }

  #clearTimer(key: string) {
    const timer = this.#timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(key);
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}
export function useWorkspaceFileDrafts() {
  const [drafts] = useState(() => new WorkspaceFileDrafts());
  useEffect(() => {
    const report = () =>
      window.zenx.workspaceFiles?.setDirty?.(drafts.hasUnsaved());
    const unsubscribe = drafts.subscribe(report);
    report();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!drafts.hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [drafts]);
  return drafts;
}
