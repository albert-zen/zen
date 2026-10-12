import { randomUUID } from "node:crypto";
import type {
  ObservationCapture,
  ObservationCoverage,
} from "./observation-capture.js";
import {
  MAX_OBSERVATION_CAPTURE_ITEMS,
  MAX_OBSERVATION_CAPTURE_TEXT,
} from "./observation-capture.js";

export interface ObservationReadOptions {
  cursor?: string;
  baseObservationId?: string;
  full?: boolean;
}

export function observationReadOptions(
  args: Readonly<Record<string, unknown>>,
): ObservationReadOptions {
  const result: ObservationReadOptions = {};
  for (const key of ["cursor", "baseObservationId"] as const) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length === 0 || value.length > 256)
        throw new Error(
          `${key} must be a nonempty string of at most 256 characters`,
        );
      result[key] = value;
    }
  }
  if (args.full !== undefined) {
    if (typeof args.full !== "boolean")
      throw new Error("full must be a boolean");
    result.full = args.full;
  }
  if (
    result.cursor !== undefined &&
    (result.baseObservationId !== undefined || result.full === true)
  )
    throw new Error(
      "A cursor reads its immutable capture; omit baseObservationId and full, or omit cursor to inspect afresh",
    );
  return result;
}

export const observationReadProperties = {
  cursor: {
    type: "string",
    description:
      "Continue the exact immutable captured observation using its returned nextCursor. Does not recapture or renew action references. Omit to inspect afresh.",
  },
  baseObservationId: {
    type: "string",
    description:
      "Request a diff only when you still retain that observation's full first-page baseline (or have applied its diffs). Omit after context compaction or lost context to receive a self-contained full view.",
  },
  full: {
    type: "boolean",
    description:
      "Force a new self-contained full bounded view. This does not mean the entire page/window was captured; follow nextCursor and inspect coverage.",
  },
} as const;

const CAPTURE_TTL_MS = 5 * 60_000;
const MAX_SCOPES = 64;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 32 * 1024;
export const MAX_OBSERVATION_PAGE_BYTES = 128 * 1024;

interface Entry<T> {
  value: T;
  rawId: string;
  ref: string;
  identity?: string;
}
interface Page<T> {
  items: T[];
  text?: string;
  itemOffset: number;
  textOffset: number;
  nextItem: number;
  nextText: number;
}
interface State<T> {
  key: string;
  id: string;
  scopeKey: string;
  header: Record<string, unknown>;
  entries: Entry<T>[];
  text?: string;
  coverage: ObservationCoverage;
  first: Page<T>;
  allowed: Set<string>;
  createdAt: number;
  bytes: number;
  valid: boolean;
  assertCurrent?: (signal?: AbortSignal) => void | Promise<void>;
  cursors: Map<string, { item: number; text: number }>;
}

/** Ephemeral model presentation; emitted full/diff receipts remain ordinary tool results. */
export class ObservationPresentation<T> {
  readonly #states = new Map<string, State<T>>();
  constructor(
    readonly adapter: {
      itemsField: "targets" | "controls";
      changesField: "targetChanges" | "controlChanges";
      textField?: "visibleText";
      pageItems: number;
      identityKind: "dom-node" | "exact-fingerprint-presentation";
      getId(value: T): string;
      withId(value: T, id: string): T;
      withObservationId?(value: T, observationId: string): T;
      now?: () => number;
    },
  ) {}

  #now(): number {
    return this.adapter.now?.() ?? Date.now();
  }

  publish(
    key: string,
    id: string,
    header: Record<string, unknown>,
    capture: ObservationCapture<T>,
    options: ObservationReadOptions,
  ): Record<string, unknown> {
    this.#expire();
    const previous = this.#states.get(key);
    const sameScope = previous?.scopeKey === capture.scopeKey;
    const counts = new Map<string, number>();
    for (const entry of capture.entries)
      if (entry.identity !== undefined)
        counts.set(entry.identity, (counts.get(entry.identity) ?? 0) + 1);
    const prior = new Map<string, string>();
    if (sameScope)
      for (const entry of previous.entries)
        if (entry.identity !== undefined) prior.set(entry.identity, entry.ref);
    const coverage: ObservationCoverage = {
      ...capture.coverage,
      reasons: [...capture.coverage.reasons],
    };
    const text =
      capture.text === undefined
        ? undefined
        : textSlice(capture.text, 0, MAX_OBSERVATION_CAPTURE_TEXT);
    header = structuredClone(header);
    if (size({ header, coverage }) > MAX_OBSERVATION_PAGE_BYTES - 8192)
      throw new Error("Observation metadata exceeds the output budget");
    let bytes = size({ header, text, coverage });
    if (bytes > MAX_CAPTURE_BYTES)
      throw new Error(
        "Observation metadata exceeds the bounded capture budget",
      );
    const entries: Entry<T>[] = [];
    const usedRefs = new Set<string>();
    const rawIds = new Set<string>();
    for (const entry of capture.entries.slice(
      0,
      MAX_OBSERVATION_CAPTURE_ITEMS,
    )) {
      const rawId = this.adapter.getId(entry.value);
      if (rawIds.has(rawId))
        throw new Error("Observation returned duplicate action references");
      rawIds.add(rawId);
      const identity =
        entry.identity !== undefined && counts.get(entry.identity) === 1
          ? entry.identity
          : undefined;
      let ref = identity === undefined ? rawId : (prior.get(identity) ?? rawId);
      if (usedRefs.has(ref)) ref = randomUUID();
      usedRefs.add(ref);
      const value = this.adapter.withId(structuredClone(entry.value), ref);
      const next = {
        value,
        rawId,
        ref,
        ...(identity === undefined ? {} : { identity }),
      };
      const entryBytes = size(next);
      if (bytes + entryBytes > MAX_CAPTURE_BYTES) break;
      entries.push(next);
      bytes += entryBytes;
    }
    if (
      entries.length < capture.entries.length ||
      (text?.length ?? 0) < (capture.text?.length ?? 0)
    ) {
      coverage.sourceComplete = false;
      coverage.reasons.push("host_capture_budget");
    }
    const state: State<T> = {
      key,
      id,
      scopeKey: capture.scopeKey,
      header,
      entries,
      ...(text === undefined ? {} : { text }),
      coverage,
      first: {
        items: [],
        itemOffset: 0,
        textOffset: 0,
        nextItem: 0,
        nextText: 0,
      },
      allowed: new Set(),
      createdAt: this.#now(),
      bytes,
      valid: true,
      ...(capture.assertCurrent === undefined
        ? {}
        : { assertCurrent: capture.assertCurrent }),
      cursors: new Map(),
    };
    state.first = this.#page(state, 0, 0);
    const full = this.#render(state, state.first, "full");
    let output = full;
    if (options.full === true)
      (full.observation as Record<string, unknown>).resetReason =
        "requested-full";
    else if (options.baseObservationId !== undefined) {
      if (previous === undefined || previous.id !== options.baseObservationId)
        (full.observation as Record<string, unknown>).resetReason =
          "base-unavailable";
      else if (!sameScope)
        (full.observation as Record<string, unknown>).resetReason =
          "scope-changed";
      else {
        const delta = this.#delta(state, previous);
        if (size(delta) < size(full)) output = delta;
        else
          (full.observation as Record<string, unknown>).resetReason =
            "diff-not-smaller";
      }
    }
    this.#states.delete(key);
    this.#states.set(key, state);
    this.#evict();
    return structuredClone(output);
  }

  async read(
    key: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const state = await this.#current(key, signal);
    this.#assertHeld(state);
    const offset = state.cursors.get(cursor);
    if (offset === undefined)
      throw new Error(
        "Observation cursor is unknown, expired, or belongs to another owner/target; omit cursor to inspect afresh",
      );
    return structuredClone(
      this.#render(
        state,
        this.#page(state, offset.item, offset.text),
        "full",
        true,
      ),
    );
  }

  async resolveAction(
    key: string,
    observationId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await this.#current(key, signal);
    this.#assertHeld(state);
    if (state.id !== observationId)
      throw new Error(
        "Observation is stale or belongs to another owner/target; inspect afresh",
      );
    if (!state.allowed.has(ref))
      throw new Error(
        "Action reference was not returned in this owner's observed pages",
      );
    const entry = state.entries.find((candidate) => candidate.ref === ref);
    if (entry === undefined)
      throw new Error("Action reference is unknown; inspect afresh");
    return entry.rawId;
  }

  async assertObservation(
    key: string,
    observationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#current(key, signal);
    this.#assertHeld(state);
    if (state.id !== observationId)
      throw new Error(
        "Observation is stale or belongs to another owner/target; inspect afresh",
      );
  }

  has(key: string): boolean {
    this.#expire();
    return this.#states.has(key);
  }
  invalidate(key: string): void {
    const state = this.#states.get(key);
    if (state !== undefined) {
      state.valid = false;
      state.cursors.clear();
    }
  }
  invalidateAll(): void {
    for (const key of this.#states.keys()) this.invalidate(key);
  }
  forget(key: string): void {
    this.#states.delete(key);
  }
  forgetPrefix(prefix: string): void {
    for (const key of this.#states.keys())
      if (key.startsWith(prefix)) this.#states.delete(key);
  }
  close(): void {
    this.#states.clear();
  }

  async #current(key: string, signal?: AbortSignal): Promise<State<T>> {
    signal?.throwIfAborted();
    this.#expire();
    const state = this.#states.get(key);
    if (state === undefined || !state.valid)
      throw new Error(
        "Observation capture is expired, consumed, or unavailable; omit cursor to inspect afresh",
      );
    try {
      await state.assertCurrent?.(signal);
      signal?.throwIfAborted();
    } catch (error) {
      if (this.#states.get(key) === state) this.invalidate(key);
      throw error;
    }
    this.#assertHeld(state);
    return state;
  }

  #assertHeld(state: State<T>): void {
    if (
      this.#states.get(state.key) !== state ||
      !state.valid ||
      this.#now() - state.createdAt >= CAPTURE_TTL_MS
    )
      throw new Error(
        "Observation changed or expired during validation; inspect afresh",
      );
  }

  #page(state: State<T>, itemOffset: number, textOffset: number): Page<T> {
    let text =
      state.text === undefined
        ? undefined
        : textSlice(state.text, textOffset, textOffset + 8_000);
    while (text !== undefined && Buffer.byteLength(text, "utf8") > 24 * 1024)
      text = textSlice(text, 0, Math.floor(text.length * 0.9));
    const items: T[] = [];
    let bytes =
      size({ ...state.header, text, coverage: state.coverage }) + 2048;
    for (const entry of state.entries.slice(
      itemOffset,
      itemOffset + this.adapter.pageItems,
    )) {
      const nextBytes = bytes + size(entry.value);
      if (nextBytes > PAGE_BYTES && items.length > 0) break;
      if (nextBytes > MAX_OBSERVATION_PAGE_BYTES - 4096) {
        if ((text?.length ?? 0) > 0) break;
        throw new Error(
          "One observation entry exceeds the output budget; this capture cannot be completely presented",
        );
      }
      items.push(entry.value);
      bytes = nextBytes;
      if (bytes > PAGE_BYTES) break;
    }
    return {
      items,
      ...(text === undefined ? {} : { text }),
      itemOffset,
      textOffset,
      nextItem: itemOffset + items.length,
      nextText: textOffset + (text?.length ?? 0),
    };
  }

  #render(
    state: State<T>,
    page: Page<T>,
    format: "full" | "diff",
    continuation = false,
  ): Record<string, unknown> {
    for (const value of page.items)
      state.allowed.add(this.adapter.getId(value));
    const hasMoreItems = page.nextItem < state.entries.length;
    const hasMoreText = page.nextText < (state.text?.length ?? 0);
    let nextCursor: string | undefined;
    if (hasMoreItems || hasMoreText) {
      const existing = [...state.cursors].find(
        ([, value]) =>
          value.item === page.nextItem && value.text === page.nextText,
      );
      nextCursor = existing?.[0] ?? randomUUID();
      state.cursors.set(nextCursor, {
        item: page.nextItem,
        text: page.nextText,
      });
    }
    return {
      ...state.header,
      observation: {
        format,
        identityKind: this.adapter.identityKind,
        capturedAt: new Date(state.createdAt).toISOString(),
        ...(continuation ? { continuation: true } : {}),
      },
      coverage: {
        ...state.coverage,
        items: {
          offset: page.itemOffset,
          returned: page.items.length,
          captured: state.entries.length,
          hasMore: hasMoreItems,
        },
        ...(state.text === undefined
          ? {}
          : {
              text: {
                offset: page.textOffset,
                returned: page.text?.length ?? 0,
                captured: state.text.length,
                hasMore: hasMoreText,
              },
            }),
        complete:
          state.coverage.sourceComplete === true &&
          page.itemOffset === 0 &&
          page.textOffset === 0 &&
          !hasMoreItems &&
          !hasMoreText,
      },
      [this.adapter.itemsField]: page.items,
      ...(this.adapter.textField === undefined || page.text === undefined
        ? {}
        : { [this.adapter.textField]: page.text }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  #delta(state: State<T>, previous: State<T>): Record<string, unknown> {
    const output = this.#render(state, state.first, "diff");
    delete output[this.adapter.itemsField];
    const oldItems = new Map(
      previous.first.items.map((item) => [this.adapter.getId(item), item]),
    );
    const nowItems = new Map(
      state.first.items.map((item) => [this.adapter.getId(item), item]),
    );
    const added: T[] = [],
      updated: T[] = [];
    for (const [id, item] of nowItems) {
      if (!oldItems.has(id)) added.push(item);
      else {
        const old = oldItems.get(id)!;
        const refreshed =
          this.adapter.withObservationId?.(old, state.id) ?? old;
        if (JSON.stringify(item) !== JSON.stringify(refreshed))
          updated.push(item);
      }
    }
    const removedFromView = [...oldItems.keys()].filter(
      (id) => !nowItems.has(id),
    );
    const changedOrder =
      JSON.stringify([...oldItems.keys()]) !==
      JSON.stringify([...nowItems.keys()]);
    const textChanged = state.first.text !== previous.first.text;
    if (!textChanged && this.adapter.textField !== undefined)
      delete output[this.adapter.textField];
    output[this.adapter.changesField] = {
      added,
      updated,
      removedFromView,
      ...(changedOrder ? { order: [...nowItems.keys()] } : {}),
    };
    Object.assign(output.observation as object, {
      baseObservationId: previous.id,
      actionObservationId: state.id,
      unchanged:
        added.length === 0 &&
        updated.length === 0 &&
        removedFromView.length === 0 &&
        !changedOrder &&
        !textChanged,
    });
    return output;
  }

  #expire(): void {
    const now = this.#now();
    for (const [key, state] of this.#states)
      if (now - state.createdAt >= CAPTURE_TTL_MS) this.#states.delete(key);
  }
  #evict(): void {
    let bytes = [...this.#states.values()].reduce(
      (sum, state) => sum + state.bytes,
      0,
    );
    while (this.#states.size > MAX_SCOPES || bytes > MAX_TOTAL_BYTES) {
      const first = this.#states.entries().next().value as
        [string, State<T>] | undefined;
      if (first === undefined) return;
      bytes -= first[1].bytes;
      this.#states.delete(first[0]);
    }
  }
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function textSlice(text: string, start: number, end: number): string {
  let result = text.slice(start, end);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
}
