import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const browserExtensionOperations = [
  "evaluate",
  "network_start",
  "network_read",
  "network_response",
  "console_start",
  "console_read",
  "content",
] as const;
export type BrowserExtensionOperation =
  (typeof browserExtensionOperations)[number];

/** A target attachment's opt-in, disposable event history, never a replay authority. */
export class BrowserEventBuffer {
  readonly id = randomUUID();
  #events: Array<{
    sequence: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  #next = 1;
  #bytes = 0;
  #dropped = 0;
  #directory?: string;
  #directoryPromise?: Promise<string>;
  #closed = false;
  #files: string[] = [];
  push(method: string, params: Record<string, unknown>): void {
    if (this.#closed) return;
    const event = {
      sequence: this.#next++,
      method,
      params: structuredClone(params),
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 4 * 1024 * 1024) {
      this.#events = [];
      this.#bytes = 0;
      this.#dropped = event.sequence;
      return;
    }
    this.#events.push(event);
    this.#bytes += bytes;
    while (this.#events.length > 2000 || this.#bytes > 4 * 1024 * 1024) {
      const removed = this.#events.shift()!;
      this.#bytes -= Buffer.byteLength(JSON.stringify(removed));
      this.#dropped = removed.sequence;
    }
  }
  hasRequest(requestId: string): boolean {
    return (
      !this.#closed &&
      this.#events.some((e) => e.params.requestId === requestId)
    );
  }
  async read(eventCursor?: string, limit = 50): Promise<unknown> {
    if (this.#closed)
      throw Error(
        "Browser event history is closed; start a new observation explicitly",
      );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error("limit must be an integer from 1 to 100");
    let after = this.#dropped;
    if (eventCursor !== undefined) {
      const prefix = `${this.id}:`;
      if (
        !eventCursor.startsWith(prefix) ||
        !/^\d+$/.test(eventCursor.slice(prefix.length))
      )
        throw Error(
          "Browser event cursor belongs to another attachment or collection",
        );
      after = Number(eventCursor.slice(prefix.length));
      if (after < this.#dropped)
        throw Error(
          "Browser event history was evicted; read without a cursor to acknowledge the lost history",
        );
      if (after >= this.#next)
        throw Error("Browser event cursor is ahead of captured history");
    }
    const snapshot = [...this.#events],
      capturedNext = this.#next,
      droppedThrough = this.#dropped;
    const events: Array<{
      sequence: number;
      method: string;
      params?: Record<string, unknown>;
      rawOnly?: boolean;
      bytes?: number;
    }> = [];
    let pageBytes = 0;
    for (const event of snapshot
      .filter((e) => e.sequence > after)
      .slice(0, limit)) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      const selected =
        bytes > 12000
          ? {
              sequence: event.sequence,
              method: event.method,
              rawOnly: true,
              bytes,
            }
          : event;
      const selectedBytes = Buffer.byteLength(JSON.stringify(selected));
      if (pageBytes + selectedBytes > 12000 && events.length) break;
      events.push(selected);
      pageBytes += selectedBytes;
    }
    // Full retained bytes are an immutable ephemeral raw file, not durable history.
    this.#directory ??= await (this.#directoryPromise ??= mkdtemp(
      path.join(os.tmpdir(), "zen-browser-events-"),
    ));
    const rawPath = path.join(
      this.#directory,
      `${droppedThrough}-${capturedNext}-${randomUUID()}.json`,
    );
    await writeFile(rawPath, JSON.stringify(snapshot), { mode: 0o600 });
    if (!this.#files.includes(rawPath)) this.#files.push(rawPath);
    while (this.#files.length > 32)
      await rm(this.#files.shift()!, { force: true });
    if (this.#closed) {
      await rm(this.#directory, { recursive: true, force: true });
      throw Error("Browser event history closed during read");
    }
    return {
      events,
      // Captured only on explicit read; existing invocation Trace stores these full bytes
      // before the model facade removes this native-only snapshot field.
      rawEvents: snapshot,
      eventCursor: `${this.id}:${events.at(-1)?.sequence ?? after}`,
      hasMore: (events.at(-1)?.sequence ?? after) < capturedNext - 1,
      droppedThrough,
      rawPath,
      retainedEvents: snapshot.length,
      rawFileLifetime: "Until collection closes or 32 newer captures are read",
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#events = [];
    const directory = this.#directory ?? (await this.#directoryPromise);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Ordinary diagnostic previews expose metadata, not header/body dumps. Raw capture is untouched. */
export function browserDiagnosticEventSummary(value: unknown): unknown {
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const pick = (v: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(
      keys
        .filter((key) =>
          ["string", "number", "boolean"].includes(typeof v[key]),
        )
        .map((key) => [key, v[key]]),
    );
  const event = object(value),
    params = object(event.params);
  if (event.rawOnly === true)
    return pick(event, ["sequence", "method", "rawOnly", "bytes"]);
  const output: Record<string, unknown> = {
    ...pick(event, ["sequence", "method"]),
  };
  const method = String(event.method ?? "");
  const address = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value);
      return ["http:", "https:", "ws:", "wss:"].includes(url.protocol)
        ? `${url.origin}${url.pathname}`
        : url.protocol;
    } catch {
      return undefined;
    }
  };
  if (method.startsWith("Network.")) {
    const metadata = pick(params, [
      "requestId",
      "timestamp",
      "wallTime",
      "type",
      "encodedDataLength",
      "canceled",
      "blockedReason",
      "errorText",
    ]);
    const request = object(params.request),
      response = object(params.response);
    if (params.request !== undefined)
      metadata.request = {
        ...pick(request, ["method", "hasPostData"]),
        ...(address(request.url) === undefined
          ? {}
          : { url: address(request.url) }),
      };
    if (params.response !== undefined)
      metadata.response = {
        ...pick(response, [
          "status",
          "statusText",
          "mimeType",
          "protocol",
          "encodedDataLength",
          "fromDiskCache",
          "fromServiceWorker",
        ]),
        ...(address(response.url) === undefined
          ? {}
          : { url: address(response.url) }),
      };
    output.params = metadata;
    return output;
  }
  if (method === "Runtime.consoleAPICalled") {
    output.params = {
      ...pick(params, ["type", "timestamp", "executionContextId"]),
      args: Array.isArray(params.args)
        ? params.args.map((arg) => {
            const entry = object(arg),
              summary = pick(entry, ["type", "subtype"]);
            if (
              entry.value === null ||
              ["string", "number", "boolean"].includes(typeof entry.value)
            )
              return { ...summary, value: entry.value };
            return { ...summary, rawOnly: true };
          })
        : [],
    };
    return output;
  }
  if (method === "Runtime.exceptionThrown") {
    output.params = {
      ...pick(params, ["timestamp"]),
      exceptionDetails: pick(object(params.exceptionDetails), [
        "exceptionId",
        "text",
        "lineNumber",
        "columnNumber",
      ]),
    };
    return output;
  }
  return { ...output, rawOnly: true };
}
