import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { decodeCanonicalItem, type CanonicalItem } from "./item.js";
import {
  contextAnnotationFromLegacy,
  contextItemsFromLegacy,
  decodeContextItem,
  legacyItemFromContext,
  type ContextItem,
} from "./item-list.js";
import { FileItemListStore } from "./item-list-store.js";
import {
  ThreadJournalAppendOutcomeUnknownError,
  type ThreadJournal,
} from "./journal.js";
import type { AttachmentStore } from "./attachment.js";
import type { ThreadMetadataStore } from "./thread-metadata.js";
import type {
  RuntimeTrace,
  TraceReader,
  TraceReceipt,
  TraceEvent,
} from "./trace.js";
import { isMissing, replaceFile, syncDirectory } from "./storage-files.js";
import { StorageWriterOwnership } from "./storage-writer-ownership.js";

/** Critical product/control facts share Trace; ACK only follows its durable receipt. */
export function requiresDurableControlFact(item: CanonicalItem): boolean {
  return new Set([
    "thread_metadata",
    "thread_configuration_changed",
    "user_message_queued",
    "thread_message_queued",
    "host_message_queued",
    "user_message_queue_edited",
    "user_message_queue_cancelled",
    "thread_message_cancelled",
    "host_message_cancelled",
    "turn_replacement_requested",
    "thread_deleted",
    "thread_restored",
    "code_state",
  ]).has(item.type);
}
interface Fence {
  format: "zen-itemlist-trace-v1";
  threadId: string;
  archiveSha256?: string;
}
export interface MigrationPreflight {
  threadId: string;
  status: "legacy" | "migrated" | "absent";
  sourceSha256?: string;
  sourceItems: number;
  semanticItems: number;
}
export interface DomainThreadJournalOptions {
  directory: string;
  trace: RuntimeTrace & TraceReader;
  metadata: ThreadMetadataStore;
  attachments?: Pick<AttachmentStore, "read">;
  access?: "read-only" | "read-write";
  onTraceDegraded?: (threadId: string, receipt: TraceReceipt) => void;
  onMigrationPhase?: (
    phase: "archived" | "traced" | "fenced" | "published",
  ) => void | Promise<void>;
}
/** Exactly three domains: semantic ItemList, durable observed Trace, existing product state. */
export class DomainThreadJournal implements ThreadJournal {
  readonly trace: RuntimeTrace & TraceReader;
  readonly #directory: string;
  readonly #items: FileItemListStore;
  readonly #options: DomainThreadJournalOptions;
  readonly #owner: StorageWriterOwnership | undefined;
  readonly #live = new Map<string, CanonicalItem[]>();
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #uncertain = new Set<string>();
  #closed = false;
  constructor(options: DomainThreadJournalOptions) {
    this.#options = options;
    this.#directory = path.resolve(options.directory);
    this.trace = options.trace;
    this.#items = new FileItemListStore(path.join(this.#directory, "items"));
    this.#owner =
      options.access === "read-only"
        ? undefined
        : new StorageWriterOwnership(this.#directory);
  }
  #path(threadId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(threadId))
      throw new Error("Invalid Thread identity");
    return path.join(this.#directory, `${threadId}.jsonl`);
  }
  #requireWriter(): void {
    if (this.#closed || this.#owner === undefined)
      throw new Error("Domain journal is closed or read-only");
    this.#owner.assertHeld();
  }
  #operation<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    this.#requireWriter();
    const next = (this.#chains.get(threadId) ?? Promise.resolve()).then(() => {
      this.#owner!.assertHeld();
      return action();
    });
    this.#chains.set(
      threadId,
      next.catch(() => undefined),
    );
    this.#operations.add(next);
    void next
      .finally(() => this.#operations.delete(next))
      .catch(() => undefined);
    return next;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#operations.size) await Promise.allSettled([...this.#operations]);
    this.#owner?.close();
  }
  async #record(event: TraceEvent, strict = false): Promise<void> {
    const receipt = await this.trace.record(event);
    if (receipt.durability === "degraded") {
      this.#options.onTraceDegraded?.(event.threadId, receipt);
      if (strict) {
        this.#uncertain.add(event.threadId);
        this.#live.delete(event.threadId);
        throw new ThreadJournalAppendOutcomeUnknownError(receipt.error);
      }
    }
  }
  async #route(
    item: CanonicalItem,
    sequence: number,
    contexts: readonly ContextItem[],
    strictImport = false,
  ): Promise<void> {
    const fields = contextAnnotationFromLegacy(item);
    if (Object.keys(fields).length)
      await this.#record(
        {
          threadId: item.threadId,
          type: "item_annotation",
          data: { itemId: item.id, sequence, fields },
        },
        strictImport,
      );
    const represented = contexts.some(
      (context) =>
        context.id === item.id &&
        legacyItemFromContext(context, fields) !== undefined,
    );
    if (!represented)
      await this.#record(
        {
          threadId: item.threadId,
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
          type: "runtime_item",
          data: {
            item,
            sequence,
            ...(strictImport ? { captureLayer: "legacy-journal" } : {}),
          },
        },
        strictImport || requiresDurableControlFact(item),
      );
  }
  async create(
    items: readonly CanonicalItem[],
    exactItemList?: readonly ContextItem[],
  ): Promise<void> {
    const first = items[0];
    if (!first) throw new Error("Thread creation requires original metadata");
    return this.#operation(first.threadId, async () => {
      if (await this.#items.exists(first.threadId))
        throw new Error("Thread already exists");
      const contexts: ContextItem[] = [];
      const previous: CanonicalItem[] = [];
      for (const raw of items) {
        const item = decodeCanonicalItem(raw);
        if (item.threadId !== first.threadId)
          throw new Error("Mixed Thread creation");
        contexts.push(
          ...contextItemsFromLegacy(item, previous, previous.length, contexts),
        );
        previous.push(item);
      }
      const semantic =
        exactItemList === undefined
          ? contexts
          : exactItemList.map(decodeContextItem);
      if (semantic.some((i) => i.threadId !== first.threadId))
        throw new Error("Mixed frozen ItemList");
      for (const [sequence, item] of previous.entries())
        await this.#route(item, sequence, semantic);
      await this.#writeFence(first.threadId);
      await this.#items.create(first.threadId, semantic);
      this.#live.set(first.threadId, structuredClone(previous));
    });
  }
  async append(raw: CanonicalItem): Promise<void> {
    const item = decodeCanonicalItem(raw);
    return this.#operation(item.threadId, async () => {
      await this.#migrate(item.threadId);
      if (this.#uncertain.has(item.threadId))
        throw new ThreadJournalAppendOutcomeUnknownError(
          "Previous control write unknown; reopen and reconcile exact identity",
        );
      if (!(await this.#items.exists(item.threadId))) {
        if (item.type !== "thread_metadata")
          throw new Error("Thread must begin with original metadata");
        const semantic = contextItemsFromLegacy(item, [], 0, []);
        await this.#route(item, 0, semantic);
        await this.#writeFence(item.threadId);
        await this.#items.create(item.threadId, semantic);
        this.#live.set(item.threadId, [item]);
        return;
      }
      const previous = await this.#read(item.threadId);
      if (previous.some((i) => i.id === item.id))
        throw new Error(
          "Duplicate canonical Item identity; reconcile instead of retrying",
        );
      const contexts = await this.#items.read(item.threadId);
      const trace = await this.trace.read(item.threadId, {
        verifyArtifacts: false,
      });
      const sequence =
        Math.max(
          previous.length - 1,
          ...contexts.map((i) => i.source.sequence),
          ...trace.records
            .filter((r) => r.type === "runtime_item")
            .map((r) =>
              Number((r.data as { sequence?: number })?.sequence ?? -1),
            ),
        ) + 1;
      const semantic = contextItemsFromLegacy(
        item,
        previous,
        sequence,
        contexts,
      );
      try {
        await this.#route(item, sequence, semantic);
        if (semantic.length) await this.#items.append(item.threadId, semantic);
      } catch (error) {
        if (error instanceof ThreadJournalAppendOutcomeUnknownError) {
          this.#uncertain.add(item.threadId);
          this.#live.delete(item.threadId);
        }
        throw error;
      }
      this.#live.set(item.threadId, [...previous, item]);
    });
  }
  async appendContext(raw: ContextItem): Promise<void> {
    const item = decodeContextItem(raw);
    return this.#operation(item.threadId, async () => {
      await this.#migrate(item.threadId);
      await this.#items.append(item.threadId, [item]);
    });
  }
  async readItemList(threadId: string): Promise<ContextItem[]> {
    if (!(await this.#items.exists(threadId)) && this.#owner !== undefined)
      await this.migrate(threadId);
    return this.#items.read(threadId);
  }
  async read(threadId: string): Promise<CanonicalItem[]> {
    if (!(await this.#items.exists(threadId)) && this.#owner !== undefined)
      await this.migrate(threadId);
    return this.#read(threadId);
  }
  async #read(threadId: string): Promise<CanonicalItem[]> {
    const live = this.#live.get(threadId);
    if (live !== undefined) return structuredClone(live);
    if (!(await this.#items.exists(threadId))) {
      const source = await this.#legacy(threadId);
      return source?.items ?? [];
    }
    const contexts = await this.#items.read(threadId);
    const observed = await this.trace.read(threadId, {
      verifyArtifacts: false,
    });
    const annotations = new Map<string, Record<string, unknown>>();
    for (const record of observed.records)
      if (record.type === "item_annotation") {
        const data = record.data as {
          itemId: string;
          fields: Record<string, unknown>;
        };
        annotations.set(data.itemId, data.fields);
      }
    const combined = new Map<
      string,
      { sequence: number; item: CanonicalItem }
    >();
    for (const record of observed.records)
      if (record.type === "runtime_item") {
        const data = record.data as { item: unknown; sequence: number };
        const item = decodeCanonicalItem(data.item);
        if (item.threadId !== threadId || !Number.isSafeInteger(data.sequence))
          throw new Error("Invalid runtime fact identity");
        const prior = combined.get(item.id);
        if (
          prior !== undefined &&
          JSON.stringify(prior.item) !== JSON.stringify(item)
        )
          throw new Error("Conflicting runtime fact identity");
        combined.set(item.id, { sequence: data.sequence, item });
      }
    for (const context of contexts) {
      const item = legacyItemFromContext(context, annotations.get(context.id));
      if (item !== undefined)
        combined.set(item.id, { sequence: context.source.sequence, item });
    }
    return [...combined.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => entry.item);
  }
  async assertRecoverySafe(threadId: string): Promise<void> {
    if (this.#uncertain.has(threadId))
      throw new ThreadJournalAppendOutcomeUnknownError(
        "Control fact outcome unknown",
      );
    const trace = await this.trace.read(threadId, { verifyArtifacts: false });
    if (
      trace.issues.some((issue) =>
        ["read_failure", "partial_frame", "invalid_frame"].includes(issue.kind),
      )
    )
      throw new Error(
        "Runtime log integrity incomplete; dispatch requires explicit reconciliation",
      );
    const known = await this.#read(threadId);
    if (
      (await this.#items.exists(threadId)) &&
      !known.some((i) => i.type === "thread_metadata")
    )
      throw new Error(
        "Original runtime configuration unavailable; cannot dispatch",
      );
  }
  async listThreadIds(): Promise<string[]> {
    let legacy: string[] = [];
    try {
      legacy = (await readdir(this.#directory))
        .filter((name) => /^[A-Za-z0-9_-]+\.jsonl$/.test(name))
        .map((name) => name.slice(0, -6));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return [
      ...new Set([...legacy, ...(await this.#items.listThreadIds())]),
    ].sort();
  }
  async #legacy(
    threadId: string,
  ): Promise<
    { bytes: Buffer; sha256: string; items: CanonicalItem[] } | undefined
  > {
    let bytes: Buffer;
    try {
      if (!(await lstat(this.#path(threadId))).isFile())
        throw new Error("Legacy journal must not be a symlink");
      bytes = await readFile(this.#path(threadId));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n"))
      throw new Error("Legacy journal has incomplete tail");
    const lines = text.split("\n").filter(Boolean);
    const first: unknown = JSON.parse(lines[0] ?? "null");
    if (first !== null && typeof first === "object" && "format" in first) {
      const fence = first as Fence;
      if (
        lines.length !== 1 ||
        fence.format !== "zen-itemlist-trace-v1" ||
        fence.threadId !== threadId
      )
        throw new Error("Unsupported or modified migration fence");
      if (fence.archiveSha256 === undefined) return undefined;
      bytes = await readFile(
        path.join(this.#directory, "legacy", `${threadId}.jsonl`),
      );
      if (hash(bytes) !== fence.archiveSha256)
        throw new Error("Legacy archive hash mismatch");
    }
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!original.endsWith("\n")) throw new Error("Legacy archive incomplete");
    const items = original
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeCanonicalItem(JSON.parse(line)));
    if (
      items.some((item) => item.threadId !== threadId) ||
      new Set(items.map((item) => item.id)).size !== items.length
    )
      throw new Error("Invalid legacy item identities");
    return { bytes, sha256: hash(bytes), items };
  }
  async preflight(threadId: string): Promise<MigrationPreflight> {
    if (await this.#items.exists(threadId))
      return {
        threadId,
        status: "migrated",
        sourceItems: 0,
        semanticItems: (await this.#items.read(threadId)).length,
      };
    const source = await this.#legacy(threadId);
    if (!source)
      return { threadId, status: "absent", sourceItems: 0, semanticItems: 0 };
    const semantic: ContextItem[] = [];
    for (const [sequence, item] of source.items.entries()) {
      semantic.push(
        ...contextItemsFromLegacy(
          item,
          source.items.slice(0, sequence),
          sequence,
          semantic,
        ),
      );
      await this.#validateMedia(item);
    }
    return {
      threadId,
      status: "legacy",
      sourceSha256: source.sha256,
      sourceItems: source.items.length,
      semanticItems: semantic.length,
    };
  }
  async #validateMedia(value: unknown): Promise<void> {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const part of value) await this.#validateMedia(part);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      (object.type === "image" || object.type === "audio") &&
      object.attachment !== undefined
    ) {
      if (!this.#options.attachments)
        throw new Error("Attachment reader required before migration");
      await this.#options.attachments.read(
        object.attachment as Parameters<AttachmentStore["read"]>[0],
      );
    }
    for (const child of Object.values(object)) await this.#validateMedia(child);
  }
  async migrate(threadId: string): Promise<void> {
    return this.#operation(threadId, () => this.#migrate(threadId));
  }
  async #migrate(threadId: string): Promise<void> {
    if (await this.#items.exists(threadId)) return;
    const checked = await this.preflight(threadId);
    if (checked.status !== "legacy") return;
    const source = (await this.#legacy(threadId))!;
    if (source.sha256 !== checked.sourceSha256)
      throw new Error("Legacy source changed after preflight");
    const archiveDirectory = path.join(this.#directory, "legacy");
    await mkdir(archiveDirectory, { recursive: true });
    const archive = path.join(archiveDirectory, `${threadId}.jsonl`);
    try {
      await link(this.#path(threadId), archive);
      await syncDirectory(archiveDirectory);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      if (hash(await readFile(archive)) !== source.sha256)
        throw new Error("Conflicting immutable legacy archive");
    }
    await this.#options.onMigrationPhase?.("archived");
    const trace = await this.trace.read(threadId, { verifyArtifacts: false });
    const imported = new Set(
      trace.records
        .filter((r) => r.type === "legacy_import_item")
        .map(
          (r) =>
            String(
              (r.data as { sourceSha256: string; sequence: number })
                .sourceSha256,
            ) +
            ":" +
            String((r.data as { sequence: number }).sequence),
        ),
    );
    if (
      !trace.records.some(
        (r) =>
          r.type === "legacy_archive" &&
          (r.data as { sha256?: string })?.sha256 === source.sha256,
      )
    )
      await this.#record(
        {
          threadId,
          type: "legacy_archive",
          data: { sha256: source.sha256, actualHistoricalWire: "unavailable" },
          artifacts: [
            {
              name: "legacy-journal",
              bytes: source.bytes,
              mediaType: "application/x-ndjson",
              captureLayer: "legacy-journal",
            },
          ],
        },
        true,
      );
    const semantic: ContextItem[] = [];
    for (const [sequence, item] of source.items.entries()) {
      const next = contextItemsFromLegacy(
        item,
        source.items.slice(0, sequence),
        sequence,
        semantic,
      );
      semantic.push(...next);
      if (imported.has(`${source.sha256}:${sequence}`)) continue;
      await this.#route(item, sequence, next, true);
      await this.#record(
        {
          threadId,
          type: "legacy_import_item",
          data: { sourceSha256: source.sha256, sequence, itemId: item.id },
        },
        true,
      );
    }
    await this.#options.onMigrationPhase?.("traced");
    await this.#writeFence(threadId, source.sha256);
    await this.#options.onMigrationPhase?.("fenced");
    await this.#items.create(threadId, semantic);
    await this.#options.onMigrationPhase?.("published");
    this.#live.set(threadId, source.items);
  }
  async #writeFence(threadId: string, archiveSha256?: string): Promise<void> {
    const fence: Fence = {
      format: "zen-itemlist-trace-v1",
      threadId,
      ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
    };
    await replaceFile(
      this.#path(threadId),
      Buffer.from(JSON.stringify(fence) + "\n"),
      undefined,
      true, // immutable archive is deliberately hardlinked before cutover
    );
  }
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
