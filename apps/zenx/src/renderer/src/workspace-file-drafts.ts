import { useEffect, useState } from "react";
import type { WorkspaceTextFile } from "../../main/workspace-files.js";

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

// Window-owned UI state, shared across Thread panels, never written to the journal.
export class WorkspaceFileDrafts {
  #entries = new Map<string, WorkspaceFileDraft>();
  #listeners = new Set<() => void>();
  snapshot = () => this.#entries;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  set(key: string, value: WorkspaceFileDraft) {
    this.#entries = new Map(this.#entries).set(key, value);
    for (const listener of this.#listeners) listener();
  }
  remove(key: string) {
    this.#entries = new Map(this.#entries);
    this.#entries.delete(key);
    for (const listener of this.#listeners) listener();
  }
  hasUnsaved = () =>
    [...this.#entries.values()].some(
      (draft) => isFileDirty(draft) || draft.saving,
    );
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
