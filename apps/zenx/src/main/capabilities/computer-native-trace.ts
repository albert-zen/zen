import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolTraceCapture } from "../../../../../src/trace-tool.js";

const context = new AsyncLocalStorage<NativeComputerDiagnostics>();
const source = "native-computer";
const stages = new Set([
  "content-requested",
  "callback-entered",
  "metadata-ready",
  "sls-entered",
  "sls-before",
  "sls-returned",
  "plan-ready",
  "completed",
  "timed-out",
]);

/** Observation only: never carries native authority, payloads, results or retry instructions. */
export class NativeComputerDiagnostics {
  #bytes = 0;
  #sequence = 0;
  #loss = false;
  #ended = false;
  #incompleteReason?: string;
  #pending: Promise<void> = Promise.resolve();
  constructor(readonly sink: ToolTraceCapture) {}
  request(operation: unknown): NativeRequestDiagnostics {
    return new NativeRequestDiagnostics(
      this,
      ++this.#sequence,
      operation === "capture" ? randomUUID() : undefined,
    );
  }
  incomplete(reason: string): void {
    this.#incompleteReason ??= reason;
  }
  write(request: number, event: string, fields: object = {}): void {
    if (this.#ended) return;
    const line =
      JSON.stringify({
        request,
        event,
        hostMonotonicNs: String(process.hrtime.bigint()),
        ...fields,
      }) + "\n";
    if (this.#bytes + Buffer.byteLength(line) > 32768) {
      this.#loss = true;
      return;
    }
    this.#bytes += Buffer.byteLength(line);
    this.#pending = this.#pending
      .then(() => this.sink.write(source, line, "native-computer-diagnostics"))
      .catch(() => {
        this.#loss = true;
      });
  }
  async end(complete: boolean): Promise<void> {
    this.#ended = true;
    if (this.#sequence === 0) return;
    await this.#pending;
    try {
      await this.sink.end(
        source,
        complete && !this.#loss && !this.#incompleteReason,
        this.#loss
          ? "diagnostic_budget_or_write_loss"
          : (this.#incompleteReason ??
              (complete ? undefined : "native_operation_incomplete")),
      );
      await this.sink.flush();
    } catch {
      /* Observation cannot change action settlement. */
    }
  }
}
export class NativeRequestDiagnostics {
  #buffer = "";
  #discard = false;
  #completed = false;
  constructor(
    readonly capture: NativeComputerDiagnostics,
    readonly id: number,
    readonly correlationId?: string,
  ) {}
  event(event: string, fields: object = {}): void {
    this.capture.write(this.id, event, fields);
  }
  marker(input: unknown, channel: "stdout" | "stderr" = "stdout"): void {
    const value = input as Record<string, unknown> | null;
    if (
      !value ||
      value.kind !== "native-capture-progress" ||
      !stages.has(value.stage as string) ||
      typeof value.monotonicNs !== "string" ||
      !/^\d{1,24}$/.test(value.monotonicNs) ||
      typeof value.mainThread !== "boolean"
    ) {
      if (channel === "stdout") {
        this.capture.incomplete("invalid_native_diagnostic_dropped");
        this.event("invalid-diagnostic-dropped");
      }
      return;
    }
    if (!this.correlationId || value.requestId !== this.correlationId) {
      this.capture.incomplete("uncorrelated_native_marker_dropped");
      this.event("uncorrelated-marker-dropped");
      return;
    }
    if (channel === "stderr")
      this.capture.incomplete("cross_pipe_capture_tail_may_be_dropped");
    else if (value.stage === "completed") this.#completed = true;
    this.event("capture-stage", {
      stage: value.stage,
      monotonicNs: value.monotonicNs,
      mainThread: value.mainThread,
    });
  }
  terminal(): void {
    if (this.correlationId && !this.#completed)
      this.capture.incomplete("native_capture_completed_marker_missing");
  }
  stderr(chunk: Buffer | string): void {
    // Bounded complete lines only; raw diagnostics may contain private titles/errors.
    for (const char of String(chunk)) {
      if (char === "\n") {
        if (!this.#discard) {
          try {
            this.marker(JSON.parse(this.#buffer), "stderr");
          } catch {
            /* Nonmarker stderr is deliberately excluded. */
          }
        }
        this.#buffer = "";
        this.#discard = false;
      } else if (!this.#discard) {
        if (this.#buffer.length >= 1024) {
          this.#buffer = "";
          this.#discard = true;
        } else this.#buffer += char;
      }
    }
  }
}
export function nativeComputerRequestDiagnostics(
  operation?: unknown,
): NativeRequestDiagnostics | undefined {
  return context.getStore()?.request(operation);
}
export async function withNativeComputerTrace<T>(
  sink: ToolTraceCapture | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sink) return operation();
  const capture = new NativeComputerDiagnostics(sink);
  let complete = false;
  try {
    const result = await context.run(capture, operation);
    complete = true;
    return result;
  } finally {
    await capture.end(complete);
  }
}
