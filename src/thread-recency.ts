import type { CanonicalItem } from "./item.js";
import { recordedTimestamp } from "./model.js";

/**
 * Disposable, append-only summary fold. The journal remains the authority.
 * A successful completion accepts the final answer; an agent item alone does not.
 */
export class ThreadRecencyProjection {
  #position = 0;
  #forked = false;
  #recentActivityAt: string | undefined;
  readonly #admissions = new Map<string, string | null>();
  readonly #answers = new Map<string, string | null>();

  read(items: readonly CanonicalItem[]): string | undefined {
    const metadata = items[0];
    const unknownImportedThrough =
      metadata?.type === "thread_metadata" &&
      metadata.importedFrom?.contextBasis?.kind === "replacement-history"
        ? metadata.importedFrom.historyItemCount
        : -1;
    for (; this.#position < items.length; this.#position++) {
      const item = items[this.#position]!;
      if (item.type === "thread_metadata" || item.type === "thread_forked") {
        this.#recentActivityAt = recordedTimestamp(item.createdAt) ?? undefined;
        if (item.type === "thread_forked") {
          this.#forked = true;
          this.#answers.clear();
        }
        continue;
      }
      const humanAdmission =
        item.type === "user_message_queued" ||
        (item.type === "turn_replacement_requested" && item.sender === undefined);
      if (humanAdmission || item.type === "user_message") {
        const key =
          "clientId" in item && item.clientId !== undefined
            ? `${item.threadId}\0${item.clientId}`
            : undefined;
        const timestamp =
          !this.#forked && this.#position <= unknownImportedThrough
            ? null
            : key !== undefined && this.#admissions.has(key)
              ? this.#admissions.get(key)!
              : recordedTimestamp(item.createdAt);
        if (humanAdmission && key !== undefined && !this.#admissions.has(key))
          this.#admissions.set(key, timestamp);
        this.#accept(timestamp);
      } else if (item.type === "agent_message") {
        this.#answers.set(
          item.turnId,
          item.incomplete === true ? null : recordedTimestamp(item.createdAt),
        );
      } else if (item.type === "tool_call") {
        this.#answers.delete(item.turnId);
      } else if (item.type === "turn_completed") {
        if (item.status === "completed")
          this.#accept(this.#answers.get(item.turnId) ?? null);
        this.#answers.delete(item.turnId);
      } else if (item.type === "turn_aborted") {
        this.#answers.delete(item.turnId);
      }
    }
    return this.#recentActivityAt;
  }

  #accept(timestamp: string | null): void {
    if (
      timestamp !== null &&
      (this.#recentActivityAt === undefined ||
        Date.parse(timestamp) > Date.parse(this.#recentActivityAt))
    )
      this.#recentActivityAt = timestamp;
  }
}
