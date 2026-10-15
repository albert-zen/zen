// CI-only, passive execution-order evidence. TAP remains the result reporter.
import { openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXECUTION_TRACE_LIMITS = Object.freeze({
  combinedBytes: 4 * 1024 * 1024,
  records: 8192,
  recordBytes: 1024,
  fieldBytes: 256,
  finalBytes: 1024,
});
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

  function emit(value, final = false) {
    const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
    // One shared budget counts both sinks, even when one is unavailable.
    const bytes = buffer.length * 2;
    const ceiling =
      EXECUTION_TRACE_LIMITS.combinedBytes -
      (final ? 0 : EXECUTION_TRACE_LIMITS.finalBytes);
    if (
      buffer.length > EXECUTION_TRACE_LIMITS.recordBytes ||
      allocatedBytes + bytes > ceiling
    )
      return false;
    allocatedBytes += bytes;
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
    if (file) trace = createExecutionTrace({ file });
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
