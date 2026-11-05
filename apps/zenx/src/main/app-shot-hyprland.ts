/**
 * Core native Hyprland capture adapted from T3 Code HyprlandSnapShot.ts at
 * 337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17 (MIT, T3 Tools Inc. 2026).
 * Full notices and exact source provenance: ../../native/hyprland-app-shot/.
 * Host-only: never expose helper paths, runner seams, or environment via IPC.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { NiriAppShotImage } from "./app-shot-niri.js";

export const HYPRLAND_APP_SHOT_HELPER = "zenx-hyprland-snap-shot";
export const HYPRLAND_APP_SHOT_BUILD = "zenx-hyprland-core-v1";
const UPSTREAM = "337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17";
const MAX_REPLY_BYTES = 128 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface HyprlandAppShotWindow {
  title: string;
  appName: string;
  appIdentifier: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  clientBounds: { x: number; y: number; width: number; height: number };
}
export interface HyprlandAppShotCapture {
  png: Buffer;
  width: number;
  height: number;
  /** Absent after identity/title/geometry drift. Never correlate replacement text. */
  window?: HyprlandAppShotWindow;
}
export type HyprlandAppShotState = {
  status:
    | "ready"
    | "unsupported-session"
    | "not-installed"
    | "update-required"
    | "error";
  message: string;
  /** This core port does not expose upstream overlays or focus commands. */
  feedbackAvailable: false;
};
export interface HyprlandAppShotOptions {
  /** Trusted host data home only; basename/subdirectory are fixed, never PATH. */
  dataHome?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  excludedPids?: readonly number[];
  createImage?: (png: Buffer) => NiriAppShotImage;
  /** Synthetic process boundary for tests, not a renderer capability. */
  runHelper?: (
    executable: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
}

function cancelled(): Error {
  const error = new Error("Hyprland App Shot capture cancelled.");
  error.name = "AbortError";
  return error;
}
function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isBounds(value: unknown): value is HyprlandAppShotWindow["bounds"] {
  return (
    isRecord(value) &&
    ["x", "y", "width", "height"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        Math.abs(value[key]) < 100_000,
    ) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
  );
}
function isWindow(value: unknown): value is HyprlandAppShotWindow {
  return (
    isRecord(value) &&
    ["title", "appName", "appIdentifier"].every(
      (key) => typeof value[key] === "string" && value[key].length <= 4096,
    ) &&
    isSize(value.processId) &&
    value.processId <= 0xffff_ffff &&
    isBounds(value.bounds) &&
    isBounds(value.clientBounds)
  );
}
function parseReply(reply: string): Record<string, unknown> {
  if (Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES)
    throw new Error("Oversized Hyprland helper reply.");
  const value: unknown = JSON.parse(reply);
  if (!isRecord(value)) throw new Error("Invalid Hyprland helper reply.");
  return value;
}
function currentHelper(value: Record<string, unknown>): boolean {
  return (
    value.protocolVersion === 1 &&
    value.buildId === HYPRLAND_APP_SHOT_BUILD &&
    value.helperVersion === "0.1.0" &&
    value.upstreamRevision === UPSTREAM
  );
}

export function isHyprlandSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !("FLATPAK_ID" in env) &&
    !("SNAP" in env) &&
    !("SNAP_NAME" in env) &&
    !(process as NodeJS.Process & { sandboxed?: boolean }).sandboxed &&
    Boolean(
      env.XDG_CURRENT_DESKTOP?.split(":").some(
        (name) => name.toLowerCase() === "hyprland",
      ),
    )
  );
}

/** The app chooses dataHome, never a renderer or a compositor response. */
export function hyprlandAppShotHelperPath(
  options: Pick<HyprlandAppShotOptions, "dataHome" | "env"> = {},
): string {
  const dataHome =
    options.dataHome ??
    ((options.env ?? process.env).XDG_DATA_HOME ||
      NodePath.join(NodeOS.homedir(), ".local", "share"));
  if (!NodePath.isAbsolute(dataHome))
    throw new Error("Hyprland helper data home must be absolute.");
  return NodePath.join(
    dataHome,
    "zenx",
    "hyprland-capture",
    HYPRLAND_APP_SHOT_HELPER,
  );
}

async function installedHelper(executable: string): Promise<boolean> {
  try {
    // Reject symlinks, wrong owners and mutable executables, including the two
    // dedicated host-owned directories. No arbitrary executable is selected.
    for (const [path, directory] of [
      [NodePath.dirname(NodePath.dirname(executable)), true],
      [NodePath.dirname(executable), true],
      [executable, false],
    ] as const) {
      const stat = await NodeFSP.lstat(path);
      if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile()) ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0 ||
        (!directory && (stat.mode & 0o100) === 0)
      ) {
        throw new Error(
          "The Hyprland helper and its dedicated directories must be user-owned, regular, non-symlink paths without group/world write access; the helper must be executable.",
        );
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Wait for child close after cancellation/timeout before cleaning its output. */
function runHelper(
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<string> {
  checkCancellation(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "Hyprland capture timed out. Check its screen-sharing permission and try again.",
          ),
        ),
      20_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES)
        stop(new Error("Oversized Hyprland helper reply."));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim().slice(0, 4096) ||
              "Hyprland capture failed. Check helper setup and screen-sharing permission.",
          ),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
async function invoke(
  options: HyprlandAppShotOptions,
  args: readonly string[],
): Promise<string> {
  checkCancellation(options.signal);
  const result = await (options.runHelper ?? runHelper)(
    hyprlandAppShotHelperPath(options),
    args,
    {
      env: options.env ?? process.env,
      signal: options.signal,
    },
  );
  checkCancellation(options.signal);
  return result;
}

/** Read-only version + Wayland registry probes; no export, install, update or grant. */
export async function getHyprlandAppShotState(
  options: HyprlandAppShotOptions = {},
): Promise<HyprlandAppShotState> {
  checkCancellation(options.signal);
  const state = (
    status: HyprlandAppShotState["status"],
    message: string,
  ): HyprlandAppShotState => ({ status, message, feedbackAvailable: false });
  const env = options.env ?? process.env;
  if (process.platform !== "linux" || !isHyprlandSession(env))
    return state(
      "unsupported-session",
      "Native App Shot requires an unsandboxed Hyprland session. Flatpak and Snap are not supported.",
    );
  if (
    !env.XDG_RUNTIME_DIR ||
    !NodePath.isAbsolute(env.XDG_RUNTIME_DIR) ||
    !/^[A-Za-z0-9_-]+$/.test(env.HYPRLAND_INSTANCE_SIGNATURE ?? "")
  )
    return state(
      "error",
      "Hyprland session environment is missing or invalid.",
    );
  try {
    if (!(await installedHelper(hyprlandAppShotHelperPath(options))))
      return state(
        "not-installed",
        "Build and install the ZenX Hyprland helper using the documented manual setup, then retry. App Shot does not install helpers automatically.",
      );
    let version: Record<string, unknown>;
    try {
      version = parseReply(await invoke(options, ["version"]));
    } catch (error) {
      checkCancellation(options.signal);
      return state(
        "update-required",
        `Rebuild and replace the Hyprland helper manually: ${error instanceof Error ? error.message : "incompatible helper"}`,
      );
    }
    if (!currentHelper(version))
      return state(
        "update-required",
        "The installed Hyprland helper is outdated or incompatible. Rebuild and replace it manually, then retry.",
      );
    const capabilities = parseReply(await invoke(options, ["check"]));
    if (
      !currentHelper(capabilities) ||
      capabilities.captureAvailable !== true ||
      capabilities.mappingVersion !== 1 ||
      capabilities.exportVersion !== 2 ||
      capabilities.feedbackAvailable !== false
    )
      return state(
        "error",
        "Hyprland returned incompatible capture capabilities. Mapping v1 and window export v2 are required.",
      );
    return state(
      "ready",
      "Helper ready. Hyprland may request screen-sharing permission on explicit capture.",
    );
  } catch (error) {
    checkCancellation(options.signal);
    return state(
      "error",
      error instanceof Error
        ? error.message
        : "Could not check Hyprland capture support.",
    );
  }
}

async function readPng(
  path: string,
  options: HyprlandAppShotOptions,
): Promise<Omit<HyprlandAppShotCapture, "window">> {
  checkCancellation(options.signal);
  const file = await NodeFSP.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let png: Buffer;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 33 ||
      stat.size > MAX_PNG_BYTES ||
      stat.nlink !== 1
    )
      throw new Error("Invalid Hyprland screenshot file.");
    png = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < png.length) {
      checkCancellation(options.signal);
      const { bytesRead } = await file.read(
        png,
        offset,
        png.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Incomplete Hyprland screenshot file.");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  checkCancellation(options.signal);
  if (
    !png.subarray(0, 8).equals(PNG_HEADER) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid Hyprland PNG header.");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > MAX_PIXELS
  )
    throw new Error("Invalid or oversized Hyprland screenshot dimensions.");
  const image = options.createImage
    ? options.createImage(png)
    : (await import("electron")).nativeImage.createFromBuffer(png);
  checkCancellation(options.signal);
  if (
    image.isEmpty() ||
    image.getSize().width !== width ||
    image.getSize().height !== height
  )
    throw new Error("Invalid or empty Hyprland screenshot.");
  const scale = Math.min(2560 / width, 1600 / height, 1);
  if (scale === 1) {
    if (png.length > MAX_OUTPUT_BYTES)
      throw new Error("Hyprland screenshot exceeds the image size limit.");
    return { png, width, height };
  }
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  const output = resized.toPNG(),
    size = resized.getSize();
  checkCancellation(options.signal);
  if (
    resized.isEmpty() ||
    output.length > MAX_OUTPUT_BYTES ||
    !output.subarray(0, 8).equals(PNG_HEADER) ||
    !isSize(size.width) ||
    !isSize(size.height) ||
    size.width > 2560 ||
    size.height > 1600
  )
    throw new Error("Invalid or oversized resized Hyprland screenshot.");
  return { png: output, ...size };
}

/** Explicit exact-window capture. No shortcut/focus/configuration/AX/attachment/model actions. */
export async function captureHyprlandActiveAppShot(
  options: HyprlandAppShotOptions = {},
): Promise<HyprlandAppShotCapture> {
  const state = await getHyprlandAppShotState(options);
  if (state.status !== "ready") throw new Error(state.message);
  const excluded = [...new Set([process.pid, ...(options.excludedPids ?? [])])];
  if (
    excluded.length > 256 ||
    excluded.some((pid) => !isSize(pid) || pid > 0xffff_ffff)
  )
    throw new Error("Invalid excluded capture process IDs.");
  checkCancellation(options.signal);
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "zenx-hyprland-capture-"),
  );
  try {
    await NodeFSP.chmod(directory, 0o700);
    const result = parseReply(
      await invoke(options, ["capture", directory, excluded.join(",")]),
    );
    if (!(result.window === null || isWindow(result.window)))
      throw new Error("Invalid Hyprland window metadata.");
    if (result.window && excluded.includes(result.window.processId))
      throw new Error("App Shot cannot capture its own application window.");
    const image = await readPng(
      NodePath.join(directory, "capture.png"),
      options,
    );
    checkCancellation(options.signal);
    return { ...image, ...(result.window ? { window: result.window } : {}) };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
