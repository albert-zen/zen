import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

/** Synthetic packaged-smoke evidence only. Never retain provider payloads or input. */
export class PackagedUiaDiagnostic {
  readonly events: Record<string, unknown>[] = [];
  dropped = 0;
  errors = 0;
  readonly started = performance.now();
  constructor(readonly destination: string | undefined) {}
  record(kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.destination) return;
    if (this.events.length >= 256) {
      this.dropped++;
      this.events.splice(128, 1);
    }
    this.events.push({
      kind,
      atMs: performance.now() - this.started,
      ...fields,
    });
  }
  receipt(call: number, text: string): void {
    if (!this.destination) return;
    try {
      if (text.length > 2_000_000) throw new Error("Oversized receipt");
      const value = JSON.parse(text);
      const operation = ["inspect", "invoke", "set_value"].includes(
        value?.operation,
      )
        ? value.operation
        : "other";
      const outcome = ["completed", "not_dispatched", "unknown"].includes(
        value?.outcome,
      )
        ? value.outcome
        : "other";
      // Native errors consist only of source-defined labels; refuse arbitrary text.
      const error =
        typeof value?.error === "string" &&
        /^provider_error_(?:inspect_element|resolve_service|read_autofocus|root_native_identity|root_uia_identity|root_process_metadata|root_native_class|runtime_id|raw_walker|walk_first_child|walk_next_sibling|control_handle|control_bounds|control_properties|control_invoke_pattern|control_value_pattern|control_native_identity)_(?:com|win32|invalid_cast|invalid_operation|overflow|other)_h[0-9a-f]{8}$/u.test(
          value.error,
        )
          ? value.error
          : value?.error === null
            ? null
            : "redacted";
      this.record("receipt", { call, operation, outcome, error });
    } catch {
      this.errors++;
    }
  }
  owner(role: "target" | "guard", pid: unknown, hwnd: unknown): void {
    if (
      Number.isSafeInteger(pid) &&
      Number(pid) > 0 &&
      typeof hwnd === "string" &&
      /^[0-9]{1,20}$/u.test(hwnd)
    )
      this.record("owner", { role, pid, hwnd });
    else this.errors++;
  }
  async heartbeat(
    directory: string,
    phase: "before-inspect" | "before-cleanup",
  ): Promise<void> {
    if (!this.destination) return;
    const requestedAtMs = performance.now() - this.started;
    try {
      const file = await open(
        path.join(directory, "target-heartbeat.json"),
        "r",
      );
      let text: string;
      try {
        const bytes = Buffer.alloc(1025);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024) throw new Error("Oversized heartbeat");
        text = bytes.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
      const value = JSON.parse(text);
      const fields: Record<string, number> = {};
      for (const key of ["sequence", "elapsedMs", "utcMs"]) {
        if (!Number.isSafeInteger(value?.[key]) || value[key] < 0)
          throw new Error("Invalid heartbeat");
        fields[key] = value[key];
      }
      this.record("heartbeat", {
        phase,
        requestedAtMs,
        observedUtcMs: Date.now(),
        ...fields,
      });
    } catch {
      this.record("heartbeat-unavailable", { phase, requestedAtMs });
    }
  }
  async finish(retainFailure = true): Promise<void> {
    if (!this.destination || !retainFailure) return;
    try {
      await mkdir(this.destination, { recursive: true });
      await writeFile(
        path.join(this.destination, "packaged-uia-diagnostic.json"),
        JSON.stringify({
          schema: 1,
          scope: "synthetic-packaged-uia-only",
          clock:
            "Node performance.now; heartbeat UTC is cross-process correlation only",
          events: this.events,
          dropped: this.dropped,
          errors: this.errors,
        }),
      );
    } catch {
      /* Evidence must not replace a smoke or cleanup failure. */
    }
  }
}
