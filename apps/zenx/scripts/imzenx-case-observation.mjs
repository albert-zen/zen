// Narrow CI diagnosis for one fixed synthetic test file; no production state.
import { openSync, readSync, writeSync, closeSync, constants } from "node:fs";
import {
  openProcessDirectory,
  readProcessFile,
  parseProcessStat,
} from "./owned-process-observation.mjs";
export const IMZENX_CASE_FILE = "apps/zenx/test/imzenx-ui.test.ts";
export const IMZENX_CASE_LIMITS = Object.freeze({
  records: 41,
  recordBytes: 512,
  inputBytes: 32768,
  combinedBytes: 80 * 1024,
  outputRecords: 80,
});
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    v,
  );
export function readTraceRunId(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const b = Buffer.alloc(1024);
    const n = readSync(fd, b, 0, b.length, 0);
    const end = b.subarray(0, n).indexOf(10);
    if (end < 0) return null;
    const row = JSON.parse(b.subarray(0, end).toString("utf8"));
    return row.kind === "start" && uuid(row.runId) ? row.runId : null;
  } finally {
    closeSync(fd);
  }
}
function currentIdentity() {
  const fd = openProcessDirectory(process.pid);
  try {
    return parseProcessStat(readProcessFile(fd, "stat", 4096));
  } finally {
    closeSync(fd);
  }
}
export function createImzenxCaseWriter({
  traceFile = process.env.ZENX_TEST_EXECUTION_TRACE_FILE,
  readRunId = readTraceRunId,
  identity = currentIdentity,
  open = openSync,
  write = writeSync,
  close = closeSync,
  utc = () => new Date().toISOString(),
} = {}) {
  let fd,
    runId,
    owner,
    sequence = 0,
    bytes = 0,
    stopped = false;
  const started = new Set(),
    completed = new Set();
  const stop = () => {
    stopped = true;
    if (fd !== undefined) {
      try {
        close(fd);
      } catch {}
      fd = undefined;
    }
  };
  function record(caseId, phase) {
    if (stopped || fd === undefined || sequence >= 41) return;
    if (
      phase !== "file-start" &&
      (!Number.isInteger(caseId) || caseId < 1 || caseId > 20)
    )
      return;
    if (phase === "case-start") {
      if (started.has(caseId)) return;
      started.add(caseId);
    } else if (phase === "case-complete") {
      if (!started.has(caseId) || completed.has(caseId)) return;
      completed.add(caseId);
    } else if (phase !== "file-start" || caseId !== 0 || sequence !== 0) return;
    try {
      const row = {
        runId,
        file: IMZENX_CASE_FILE,
        pid: owner.pid,
        ppid: owner.ppid,
        startTicks: owner.startTicks,
        sequence: sequence + 1,
        caseId,
        phase,
        utc: utc(),
      };
      const buffer = Buffer.from(JSON.stringify(row) + "\n");
      if (buffer.length > 480 || bytes + buffer.length > 41 * 512) {
        stop();
        return;
      }
      // One small O_APPEND write; a partial write stops this producer permanently.
      const n = write(fd, buffer, 0, buffer.length);
      sequence++;
      bytes += buffer.length;
      if (n !== buffer.length) stop();
    } catch {
      stop();
    }
  }
  try {
    if (!traceFile) return { record: () => {}, close: () => {} };
    runId = readRunId(traceFile);
    owner = identity();
    if (
      !uuid(runId) ||
      !owner ||
      owner.pid !== process.pid ||
      owner.ppid !== process.ppid
    )
      return { record: () => {}, close: () => {} };
    fd = open(
      `${traceFile}.imzenx-${runId}.ndjson`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND,
      0o600,
    );
    record(0, "file-start");
  } catch {
    stop();
  }
  return { record, close: stop };
}
export function readCaseSidecar(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const b = Buffer.alloc(limit + 1);
    const n = readSync(fd, b, 0, b.length, null);
    if (n > limit || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw Error("bounded sidecar exceeded");
    return b.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
export function createImzenxCaseReader({
  file,
  runId,
  read = readCaseSidecar,
  emit,
  canRead = () => true,
}) {
  let seen = 0,
    attempts = 0;
  return (nodes = []) => {
    if (!uuid(runId) || attempts >= 32 || !canRead(41 - seen)) return;
    attempts++;
    let text;
    try {
      text = read(`${file}.imzenx-${runId}.ndjson`, 32768);
      if (typeof text !== "string" || Buffer.byteLength(text) > 32768)
        throw Error("oversize");
    } catch {
      emit({
        kind: "imzenx-observation",
        state: "unavailable",
        attempt: attempts,
        newRecords: 0,
      });
      return;
    }
    const last = text.lastIndexOf("\n"),
      partial = last !== text.length - 1;
    const lines = last < 0 ? [] : text.slice(0, last).split("\n");
    if (lines.length > 41) {
      emit({
        kind: "imzenx-observation",
        state: "invalid",
        attempt: attempts,
        newRecords: 0,
      });
      return;
    }
    let rows = [];
    try {
      rows = lines.map((line, index) => {
        if (Buffer.byteLength(line) + 1 > 480) throw Error("row bound");
        const r = JSON.parse(line);
        if (
          Object.keys(r).sort().join(",") !==
            "caseId,file,phase,pid,ppid,runId,sequence,startTicks,utc" ||
          r.runId !== runId ||
          r.file !== IMZENX_CASE_FILE ||
          r.sequence !== index + 1 ||
          !Number.isSafeInteger(r.pid) ||
          r.pid <= 0 ||
          !Number.isSafeInteger(r.ppid) ||
          r.ppid <= 0 ||
          !Number.isSafeInteger(r.startTicks) ||
          r.startTicks < 0 ||
          !Number.isInteger(r.caseId) ||
          r.caseId < 0 ||
          r.caseId > 20 ||
          typeof r.utc !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(r.utc)
        )
          throw Error("invalid receipt");
        if (
          index === 0
            ? r.phase !== "file-start" || r.caseId !== 0
            : !["case-start", "case-complete"].includes(r.phase) ||
              r.caseId === 0
        )
          throw Error("invalid phase");
        return r;
      });
      const first = rows[0];
      if (
        !first ||
        !nodes.some(
          (n) =>
            n.pid === first.pid &&
            n.ppid === first.ppid &&
            n.startTicks === first.startTicks,
        ) ||
        rows.some(
          (r) =>
            r.pid !== first.pid ||
            r.ppid !== first.ppid ||
            r.startTicks !== first.startTicks,
        )
      ) {
        emit({
          kind: "imzenx-observation",
          state: "unmatched",
          attempt: attempts,
          newRecords: 0,
        });
        return;
      }
      const starts = new Set(),
        ends = new Set();
      for (const r of rows.slice(1)) {
        if (r.phase === "case-start") {
          if (starts.has(r.caseId)) throw Error("duplicate");
          starts.add(r.caseId);
        } else {
          if (!starts.has(r.caseId) || ends.has(r.caseId))
            throw Error("invalid completion");
          ends.add(r.caseId);
        }
      }
    } catch {
      emit({
        kind: "imzenx-observation",
        state: "invalid",
        attempt: attempts,
        newRecords: 0,
      });
      return;
    }
    let added = 0;
    for (const r of rows) {
      if (r.sequence <= seen) continue;
      if (emit({ kind: "imzenx-case", ...r }) === false) break;
      seen = r.sequence;
      added++;
    }
    emit({
      kind: "imzenx-observation",
      state: partial ? "partial" : "observed",
      attempt: attempts,
      newRecords: added,
    });
  };
}
