// CI-only, passive execution-order evidence. TAP remains the result reporter.
import { openSync, readSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXECUTION_TRACE_LIMITS = Object.freeze({
  combinedBytes: 4 * 1024 * 1024,
  records: 8192,
  recordBytes: 1024,
  fieldBytes: 256,
  finalBytes: 1024,
});
// Separate additive budget: original dequeue evidence keeps its entire budget.
export const RESOURCE_TRACE_LIMITS = Object.freeze({
  intervalMs: 15_000,
  records: 32,
  combinedBytes: 32 * 1024,
});
const RESOURCE_PATHS = Object.freeze({
  meminfo: "/proc/meminfo",
  v2: "/sys/fs/cgroup/cgroup.controllers",
  current: "/sys/fs/cgroup/memory.current",
  max: "/sys/fs/cgroup/memory.max",
  events: "/sys/fs/cgroup/memory.events",
});

function readBoundedSystemFile(file, limit) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("Resource input exceeds bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    closeSync(fd);
  }
}

function numeric(value) {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function field(text, key, unit = "") {
  if (text === null) return null;
  const lines = text
    .split("\n")
    .filter((line) => line.startsWith(`${key}${unit ? ":" : " "}`));
  if (lines.length !== 1) return null;
  const pattern = unit
    ? new RegExp(`^${key}:\\s+([0-9]+) ${unit}\\s*$`, "u")
    : new RegExp(`^${key} ([0-9]+)\\s*$`, "u");
  return numeric(pattern.exec(lines[0])?.[1]);
}

/** Event-driven system totals; never a per-child or job RSS measurement. */
export function createResourceObservation({
  platform = process.platform,
  read = readBoundedSystemFile,
  monotonic = () => performance.now(),
  utc = () => new Date().toISOString(),
  started = monotonic(),
  emit,
  canEmit = () => true,
}) {
  let lastAttempt = -Infinity;
  let samples = 0;
  return () => {
    if (
      platform !== "linux" ||
      samples >= RESOURCE_TRACE_LIMITS.records ||
      !canEmit()
    )
      return;
    const now = monotonic();
    if (
      !Number.isFinite(now) ||
      now - lastAttempt < RESOURCE_TRACE_LIMITS.intervalMs
    )
      return;
    lastAttempt = now; // Failures also consume the interval; no catch-up reads.
    const bounded = (file, limit) => {
      try {
        const text = read(file, limit);
        return typeof text === "string" && Buffer.byteLength(text) <= limit
          ? text
          : null;
      } catch {
        return null;
      }
    };
    const info = bounded(RESOURCE_PATHS.meminfo, 16 * 1024);
    const v2 = bounded(RESOURCE_PATHS.v2, 4096) !== null;
    const current = v2 ? bounded(RESOURCE_PATHS.current, 128) : null;
    const max = v2 ? bounded(RESOURCE_PATHS.max, 128) : null;
    const events = v2 ? bounded(RESOURCE_PATHS.events, 4096) : null;
    const maxText = max?.trim();
    const maxBytes = numeric(maxText);
    samples += 1;
    emit({
      kind: "resource",
      sequence: samples,
      utc: utc(),
      elapsedMs: Math.round((now - started) * 1000) / 1000,
      scope: "host-visible-and-visible-cgroup-root",
      cgroupVersion: v2 ? 2 : null,
      memTotalKiB: field(info, "MemTotal", "kB"),
      memAvailableKiB: field(info, "MemAvailable", "kB"),
      swapTotalKiB: field(info, "SwapTotal", "kB"),
      swapFreeKiB: field(info, "SwapFree", "kB"),
      currentBytes: numeric(current?.trim()),
      maxBytes,
      limitState:
        maxText === "max"
          ? "unlimited"
          : maxBytes === null
            ? "unavailable"
            : "bounded",
      oom: field(events, "oom"),
      oomKill: field(events, "oom_kill"),
      oomGroupKill: field(events, "oom_group_kill"),
    });
  };
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

// Bound the JSON-encoded field, including escapes, without splitting UTF-8.
function boundedField(value) {
  let result = "";
  for (const scalar of value) {
    const character = Buffer.from(scalar).toString("utf8");
    if (
      Buffer.byteLength(JSON.stringify(result + character)) >
      EXECUTION_TRACE_LIMITS.fieldBytes
    )
      break;
    result += character;
  }
  return result;
}

function relativeLocation(root, cwd, value) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const relative = path.relative(root, path.resolve(cwd, value));
  if (
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !/^apps\/zenx\/test\/.+\.test\.(?:ts|mjs)$/u.test(
      relative.split(path.sep).join("/"),
    )
  )
    return undefined;
  return relative.split(path.sep).join("/");
}

/** Exported for bounded sink tests; production uses only the fixed limits above. */
export function createExecutionTrace({
  root = repoRoot,
  cwd = process.cwd(),
  file,
  open = openSync,
  write = writeSync,
  close = closeSync,
  utc = () => new Date().toISOString(),
  monotonic = () => performance.now(),
  resourceObservation = false,
  resourceRead = readBoundedSystemFile,
  resourcePlatform = process.platform,
}) {
  let descriptor;
  let fileAvailable = false;
  let consoleAvailable = true;
  let unavailableReported = false;
  let stopped = false;
  let truncated = false;
  let recorded = 0;
  let ignored = 0;
  let dropped = 0;
  let allocatedBytes = 0;
  let resourceBytes = 0;
  const started = monotonic();

  function writeAll(fd, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const count = write(fd, buffer, offset, buffer.length - offset);
      if (
        !Number.isInteger(count) ||
        count <= 0 ||
        count > buffer.length - offset
      )
        throw new Error("Execution trace write did not advance");
      offset += count;
    }
  }

  function emit(value, final = false, resource = false) {
    const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
    // One shared budget counts both sinks, even when one is unavailable.
    const bytes = buffer.length * 2;
    const ceiling =
      EXECUTION_TRACE_LIMITS.combinedBytes -
      (final ? 0 : EXECUTION_TRACE_LIMITS.finalBytes);
    if (
      buffer.length > EXECUTION_TRACE_LIMITS.recordBytes ||
      (resource
        ? resourceBytes + bytes > RESOURCE_TRACE_LIMITS.combinedBytes
        : allocatedBytes + bytes > ceiling)
    )
      return false;
    if (resource) resourceBytes += bytes;
    else allocatedBytes += bytes;
    if (fileAvailable) {
      try {
        writeAll(descriptor, buffer);
      } catch {
        fileAvailable = false;
      }
    }
    if (consoleAvailable) {
      try {
        writeAll(2, buffer);
      } catch {
        consoleAvailable = false;
      }
    }
    return true;
  }

  function reportUnavailable() {
    if (unavailableReported || (fileAvailable && consoleAvailable)) return;
    unavailableReported = true;
    emit(
      { kind: "diagnostic-unavailable", fileAvailable, consoleAvailable },
      true,
    );
  }

  function exhaust() {
    if (truncated) return;
    truncated = true;
    emit({ kind: "budget-exhausted", recorded }, true);
  }

  try {
    descriptor = open(file, "wx", 0o600);
    fileAvailable = true;
  } catch {
    // A diagnostic failure must not replace the suite's original outcome.
  }
  emit({
    kind: "start",
    utc: utc(),
    elapsedMs: 0,
    timeBasis: "reporter-receipt",
    caseEventsMayBeBuffered: true,
  });
  reportUnavailable();

  const observeResource = resourceObservation
    ? createResourceObservation({
        platform: resourcePlatform,
        read: resourceRead,
        utc,
        monotonic,
        started,
        canEmit: () =>
          resourceBytes + 2 * EXECUTION_TRACE_LIMITS.recordBytes <=
          RESOURCE_TRACE_LIMITS.combinedBytes,
        emit: (value) => emit(value, false, true),
      })
    : undefined;

  return {
    observe(event) {
      if (stopped || event.type !== "test:dequeue") return;
      if (truncated) {
        dropped = increment(dropped);
        return;
      }
      const data = event.data;
      const relative = relativeLocation(root, cwd, data.file);
      if (relative === undefined || typeof data.name !== "string") {
        ignored = increment(ignored);
        return;
      }
      let name = data.name;
      const fileDequeue = relativeLocation(root, cwd, name) === relative;
      if (fileDequeue) name = relative;
      else if (path.isAbsolute(name) || /^[A-Za-z]:[\\/]|^file:/u.test(name))
        name = "[non-repository test name]";
      const projectedFile = boundedField(relative);
      const projectedName = boundedField(name);
      const value = {
        kind: "dequeue",
        // File wrappers can name their location relative to the runner cwd.
        // Compare only normalized eligible repository paths, never emit cwd.
        // Node 22 can buffer later-file cases: these are receipt timestamps.
        scope: fileDequeue ? "file" : "case",
        sequence: recorded + 1,
        file: projectedFile,
        name: projectedName,
        fileTruncated: projectedFile !== relative,
        nameTruncated: projectedName !== name,
        nesting: Number.isSafeInteger(data.nesting) ? data.nesting : null,
        utc: utc(),
        elapsedMs: Math.round((monotonic() - started) * 1000) / 1000,
      };
      if (recorded >= EXECUTION_TRACE_LIMITS.records || !emit(value)) {
        dropped = increment(dropped);
        exhaust();
      } else recorded += 1;
      reportUnavailable();
      // Resource IO is gated by time and a separate budget, after dequeue output.
      try {
        if (!truncated) observeResource?.();
      } catch {
        /* Observations cannot fail the suite. */
      }
    },
    unavailable() {
      if (unavailableReported) return;
      unavailableReported = true;
      emit({ kind: "diagnostic-unavailable" }, true);
    },
    finish() {
      if (stopped) return;
      stopped = true;
      emit(
        {
          kind: "end",
          recorded,
          ignored,
          dropped,
          truncated,
          fileAvailable,
          consoleAvailable,
        },
        true,
      );
      reportUnavailable();
      if (descriptor !== undefined) {
        try {
          close(descriptor);
        } catch {
          fileAvailable = false;
          reportUnavailable();
        }
      }
    },
  };
}

export default async function* executionReporter(source) {
  // Do not inherit reporter flags via NODE_OPTIONS or change test children.
  // No signal handlers, timers, process inspection, or process termination.
  let trace;
  const file = process.env.ZENX_TEST_EXECUTION_TRACE_FILE;
  try {
    if (file) trace = createExecutionTrace({ file, resourceObservation: true });
    for await (const event of source) {
      try {
        trace?.observe(event);
      } catch {
        trace?.unavailable();
      }
    }
  } catch {
    trace?.unavailable();
  } finally {
    trace?.finish();
  }
}
