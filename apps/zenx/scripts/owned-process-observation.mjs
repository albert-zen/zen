// CI-only Linux process-leader descendant observation; never a process controller.
import { openSync, closeSync, readSync, constants } from "node:fs";

export const OWNED_PROCESS_LIMITS = Object.freeze({
  candidates: 8,
  depth: 2,
  reads: 80,
  inputBytes: 128 * 1024,
  softElapsedMs: 200,
  records: 32,
  recordBytes: 2048,
  combinedBytes: 128 * 1024,
});
const positive = (text) => {
  if (!/^[1-9][0-9]*$/u.test(text ?? "")) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};
const nonnegative = (text) => {
  if (!/^[0-9]+$/u.test(text ?? "")) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

// comm may contain spaces, parentheses and newlines. Only the final ')' closes it.
export function parseProcessStat(text) {
  const begin = /^([1-9][0-9]*) \(/u.exec(text);
  const end = text.lastIndexOf(") ");
  if (!begin || end < begin[0].length) return null;
  const rest = text
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  if (rest.length < 20 || !/^[A-Za-z]$/u.test(rest[0])) return null;
  const pid = positive(begin[1]),
    ppid = nonnegative(rest[1]);
  const startTicks = nonnegative(rest[19]); // field 22; rest begins at field 3.
  return pid !== null && ppid !== null && startTicks !== null
    ? { pid, ppid, startTicks }
    : null;
}
function statusField(text, key, unit = "") {
  const lines = text.split("\n").filter((line) => line.startsWith(`${key}:`));
  if (lines.length !== 1) return null;
  const match = new RegExp(
    `^${key}:\\s+([0-9]+)${unit ? ` ${unit}` : ""}\\s*$`,
    "u",
  ).exec(lines[0]);
  return nonnegative(match?.[1]);
}
function parseChildren(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const ids = trimmed.split(/\s+/u).map(positive);
  return ids.some((pid) => pid === null) ? null : [...new Set(ids)];
}
const same = (a, b) =>
  a &&
  b &&
  a.pid === b.pid &&
  a.ppid === b.ppid &&
  a.startTicks === b.startTicks;

export function openProcessDirectory(pid) {
  return openSync(
    `/proc/${pid}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}
export function readProcessFile(directory, suffix, limit) {
  // Magic-link traversal is anchored to this open proc directory, not a fresh PID lookup.
  const fd = openSync(
    `/proc/self/fd/${directory}/${suffix}`,
    constants.O_RDONLY,
  );
  try {
    const buffer = Buffer.alloc(limit + 1);
    const length = readSync(fd, buffer, 0, buffer.length, null);
    if (length > limit || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new Error("bounded proc input exceeded");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    closeSync(fd);
  }
}

/** No cached PID identity, global /proc scan, arguments, environment or signals. */
export function observeOwnedProcesses({
  pid = process.pid,
  mainThread = true,
  platform = process.platform,
  open = openProcessDirectory,
  read = readProcessFile,
  close = closeSync,
  monotonic = () => performance.now(),
} = {}) {
  const result = {
    scope: "leader-descendants",
    state: "partial",
    incomplete: true,
    candidates: 0,
    rejected: 0,
    readErrors: 0,
    capped: false,
    reads: 0,
    inputBytes: 0,
    nodes: [],
  };
  if (platform !== "linux" || !mainThread || !positive(String(pid))) {
    result.state = "unsupported";
    return result;
  }
  const started = monotonic(),
    handles = [],
    seen = new Set([pid]);
  function bounded(handle, suffix, limit) {
    // Reserve all possible input bytes before IO, including overflow detection.
    if (
      result.reads >= OWNED_PROCESS_LIMITS.reads ||
      result.inputBytes + limit + 2 > OWNED_PROCESS_LIMITS.inputBytes ||
      monotonic() - started > OWNED_PROCESS_LIMITS.softElapsedMs
    ) {
      result.capped = true;
      throw new Error("observation budget exhausted");
    }
    result.reads++;
    result.inputBytes += limit + 2;
    let value;
    try {
      value = read(handle, suffix, limit);
    } catch (error) {
      result.readErrors++;
      throw error;
    }
    if (typeof value !== "string" || Buffer.byteLength(value) > limit)
      throw new Error("invalid bounded input");
    return value;
  }
  const stat = (handle) => parseProcessStat(bounded(handle, "stat", 4096));
  const children = (node) =>
    parseChildren(
      bounded(node.handle, `task/${node.identity.pid}/children`, 1024),
    );
  function acquire(id) {
    if (monotonic() - started > OWNED_PROCESS_LIMITS.softElapsedMs) {
      result.capped = true;
      throw new Error("time budget");
    }
    const handle = open(id);
    handles.push(handle);
    return handle;
  }
  try {
    const root = {
      handle: acquire(pid),
      identity: null,
      depth: 0,
      parent: null,
    };
    root.identity = stat(root.handle);
    if (!root.identity || root.identity.pid !== pid)
      throw new Error("root unavailable");
    const queue = [root];
    for (let q = 0; q < queue.length && !result.capped; q++) {
      const parent = queue[q];
      if (parent.depth >= OWNED_PROCESS_LIMITS.depth) continue;
      let ids;
      try {
        ids = children(parent);
      } catch {
        result.rejected++;
        if (parent === root) throw new Error("root children unavailable");
        continue;
      }
      if (ids === null) {
        result.rejected++;
        continue;
      }
      for (const id of ids) {
        if (result.candidates >= OWNED_PROCESS_LIMITS.candidates) {
          result.capped = true;
          break;
        }
        result.candidates++;
        if (seen.has(id)) {
          result.rejected++;
          continue;
        }
        seen.add(id);
        try {
          const handle = acquire(id),
            before = stat(handle);
          if (
            !before ||
            before.pid !== id ||
            before.ppid !== parent.identity.pid
          )
            throw new Error("ownership changed");
          const status = bounded(handle, "status", 4096);
          const after = stat(handle);
          if (
            !same(before, after) ||
            statusField(status, "Pid") !== id ||
            statusField(status, "PPid") !== parent.identity.pid
          )
            throw new Error("identity changed");
          // Revalidate every anchored ancestor and membership, including root.
          let childId = id;
          for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
            if (
              !same(ancestor.identity, stat(ancestor.handle)) ||
              !children(ancestor)?.includes(childId)
            )
              throw new Error("ancestry changed");
            childId = ancestor.identity.pid;
          }
          const node = {
            pid: id,
            ppid: before.ppid,
            startTicks: before.startTicks,
            depth: parent.depth + 1,
            rssKiB: statusField(status, "VmRSS", "kB"),
            swapKiB: statusField(status, "VmSwap", "kB"),
            threads: statusField(status, "Threads"),
          };
          result.nodes.push(node);
          queue.push({ handle, identity: before, depth: node.depth, parent });
        } catch {
          result.rejected++;
        }
        if (result.capped) break;
      }
    }
    result.state = "observed";
  } catch {
    result.state = "unavailable";
  } finally {
    for (const handle of handles.reverse()) {
      try {
        close(handle);
      } catch {}
    }
  }
  result.durationMs = Math.max(
    0,
    Math.round((monotonic() - started) * 1000) / 1000,
  );
  return result;
}
