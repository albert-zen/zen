import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeToolEnvironment } from "../../../src/tool.js";

// One-shot #429 diagnostic, never an interactive readiness assertion. Both arms
// suppress profiles so their output and side effects cannot enter this query.
export const QUERY_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
];
export const QUERY = `
$ErrorActionPreference = 'Stop'
try {
  $known = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $user = [Environment]::GetEnvironmentVariable('USERPROFILE')
  $homeValue = [string]$HOME
  $hasHome = -not [string]::IsNullOrEmpty($homeValue)
  $hasKnown = -not [string]::IsNullOrEmpty($known)
  $hasUser = -not [string]::IsNullOrEmpty($user)
  $values = @(
    $hasUser,
    (-not $hasHome),
    (-not $hasKnown),
    ($hasHome -and $hasKnown -and [string]::Equals($homeValue, $known, [StringComparison]::OrdinalIgnoreCase)),
    ($hasHome -and $hasUser -and [string]::Equals($homeValue, $user, [StringComparison]::OrdinalIgnoreCase)),
    [IO.Directory]::Exists($homeValue),
    [IO.Directory]::Exists($known)
  )
  [Console]::WriteLine('ZEN_USERPROFILE_V1|' + $PSVersionTable.PSVersion.ToString() + '|' + $PSVersionTable.PSEdition + '|' + ($values -join '|'))
} catch { exit 2 }
`;
const KEYS = [
  "envUserProfilePresent",
  "homeEmpty",
  "knownUserProfileEmpty",
  "homeEqualsKnownUserProfile",
  "homeEqualsEnvUserProfile",
  "homeDirectoryExists",
  "knownUserProfileDirectoryExists",
] as const;
export type Receipt = { version: string; edition: "Desktop" } & Record<
  (typeof KEYS)[number],
  boolean
>;

export function parseReceipt(raw: string): Receipt | undefined {
  const match =
    /^ZEN_USERPROFILE_V1\|(5\.1\.\d{1,10}\.\d{1,10})\|Desktop\|((?:True|False)(?:\|(?:True|False)){6})\r?\n?$/.exec(
      raw,
    );
  if (!match) return undefined;
  const values = match[2]!.split("|");
  return {
    version: match[1]!,
    edition: "Desktop",
    ...Object.fromEntries(KEYS.map((key, i) => [key, values[i] === "True"])),
  } as Receipt;
}

export function environments(source: NodeJS.ProcessEnv, cwd: string) {
  // Explicitly omit aliases too: tests may run on a non-Windows developer host.
  const input = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => key.toUpperCase() !== "USERPROFILE",
    ),
  );
  const a = sanitizeToolEnvironment({ ...input, HOME: cwd, SHELL: "/bin/sh" });
  const originals = Object.entries(source).filter(
    ([key]) => key.toUpperCase() === "USERPROFILE",
  );
  if (originals.length !== 1 || !originals[0]![1]) return undefined;
  return { a, b: { ...a, USERPROFILE: originals[0]![1]! } };
}

type Outcome =
  | { status: "observed"; receipt: Receipt }
  | {
      status:
        | "timeout"
        | "output-limit"
        | "spawn-error"
        | "query-error"
        | "invalid-receipt"
        | "cleanup-unconfirmed";
    };
export function runQuery(
  env: NodeJS.ProcessEnv,
  cwd: string,
  {
    launch = spawn,
    queryMs = 20000,
    cleanupMs = 5000,
  }: { launch?: typeof spawn; queryMs?: number; cleanupMs?: number } = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = launch(
        "powershell.exe",
        [...QUERY_ARGS, Buffer.from(QUERY, "utf16le").toString("base64")],
        { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolve({ status: "spawn-error" });
      return;
    }
    let raw = "";
    let bytes = 0;
    let failure: Exclude<Outcome["status"], "observed"> | undefined;
    let settled = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cleanup) clearTimeout(cleanup);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(result);
    };
    const stop = (reason: typeof failure) => {
      if (settled || failure) return;
      failure = reason;
      // Exact ChildProcess handle only; no tree/PID scans or unowned kills.
      cleanup = setTimeout(
        () => finish({ status: "cleanup-unconfirmed" }),
        cleanupMs,
      );
      try {
        child.kill();
      } catch {
        /* Close, not kill's return, establishes settlement. */
      }
    };
    const deadline = setTimeout(() => stop("timeout"), queryMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) stop("output-limit");
      else if (!failure) raw += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Drain/count but never retain or print potential user paths/errors.
      bytes += chunk.length;
      if (bytes > 4096) stop("output-limit");
    });
    child.on("error", () => stop("spawn-error"));
    child.on("close", (code, signal) => {
      if (failure) {
        finish({ status: failure });
        return;
      }
      if (code !== 0 || signal !== null) {
        finish({ status: "query-error" });
        return;
      }
      const receipt = parseReceipt(raw);
      finish(
        receipt
          ? { status: "observed", receipt }
          : { status: "invalid-receipt" },
      );
    });
  });
}

export function compare(a: Receipt, b: Receipt) {
  if (
    a.version !== b.version ||
    a.envUserProfilePresent ||
    !b.envUserProfilePresent
  )
    return "inconclusive";
  const relationships = KEYS.filter(
    (key) =>
      key !== "envUserProfilePresent" && key !== "homeEqualsEnvUserProfile",
  );
  if (relationships.every((key) => a[key] === b[key])) return "same";
  if (
    !a.homeEqualsKnownUserProfile &&
    b.homeEqualsKnownUserProfile &&
    b.homeEqualsEnvUserProfile &&
    b.homeDirectoryExists
  )
    return "compatibility-difference";
  return "inconclusive";
}

async function main() {
  if (process.platform !== "win32") {
    console.info(JSON.stringify({ result: "unsupported-platform" }));
    return;
  }
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "zen-userprofile-semantics-"),
  );
  try {
    const pair = environments(process.env, cwd);
    if (!pair) {
      console.info(JSON.stringify({ result: "missing-baseline" }));
      return;
    }
    const a = await runQuery(pair.a, cwd);
    if (a.status !== "observed") {
      console.info(JSON.stringify({ result: "inconclusive", a }));
      return;
    }
    const b = await runQuery(pair.b, cwd);
    console.info(
      JSON.stringify({
        result:
          b.status === "observed"
            ? compare(a.receipt, b.receipt)
            : "inconclusive",
        a,
        b,
      }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {
      console.info(JSON.stringify({ result: "fixture-cleanup-unconfirmed" }));
      process.exitCode = 1;
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.info(JSON.stringify({ result: "probe-error" }));
    process.exitCode = 1;
  });
