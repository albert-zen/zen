/**
 * Dedicated KDE capture client adapted from T3 Code at
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/KdeSnapShot.ts
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * No install, update, desktop registration, activation, or feedback authority.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const KDE_APP_SHOT_PROTOCOL_VERSION = 1;
export const KDE_APP_SHOT_EXECUTABLE = "zenx-kde-snap-shot";
export const KDE_APP_SHOT_DESKTOP =
  "io.github.albert_zen.ZenX.KdeCapture.desktop";
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SETUP_MESSAGE =
  "KDE App Shot requires the dedicated ZenX helper and its desktop authorization entry to be installed manually. No desktop settings have been changed.";

export interface KdeAppShotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface KdeAppShotWindow {
  id: string;
  title: string;
  appName: string;
  appIdentifier: string;
  processId: number;
  bounds: KdeAppShotBounds;
  clientBounds: KdeAppShotBounds;
}
export interface KdeAppShotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: "best";
  }): KdeAppShotImage;
  toPNG(): Buffer;
}
export interface KdeAppShotCapture {
  png: Buffer;
  width: number;
  height: number;
  /** Native helper checks this exact identity again after capture. Missing means pixels only. */
  window?: KdeAppShotWindow;
}
export interface KdeAppShotOptions {
  /** Host-owned paths and environment only. Never pass renderer-supplied values here. */
  dataHome?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  excludedPids?: readonly number[];
  /** Native image boundary for synthetic tests; Electron by default. */
  createImage?: (png: Buffer) => KdeAppShotImage;
  /** Tests may shorten, never extend, the production process deadline. */
  timeoutMs?: number;
}
export interface KdeAppShotSupport {
  available: boolean;
  status: "ready" | "manual-setup-required" | "unavailable" | "error";
  message: string;
  protocolVersion: 1;
  feedbackAvailable: false;
}

export function isKdeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    !env.FLATPAK_ID &&
    !env.SNAP &&
    Boolean(
      env.XDG_CURRENT_DESKTOP?.split(":").some(
        (name) => name.toLowerCase() === "kde",
      ),
    )
  );
}

/** Fixed names under the host's XDG data directory. No PATH lookup or bundled executable fallback. */
export function kdeAppShotPaths(
  options: Pick<KdeAppShotOptions, "dataHome" | "env"> = {},
) {
  const env = options.env ?? process.env;
  const dataHome =
    options.dataHome ??
    env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".local", "share");
  if (!path.isAbsolute(dataHome) || /[\0\r\n]/u.test(dataHome))
    throw new Error(
      "KDE helper data directory must be an absolute host-owned path.",
    );
  return {
    dataHome: path.resolve(dataHome),
    executable: path.join(
      dataHome,
      "zenx",
      "kde-capture",
      KDE_APP_SHOT_EXECUTABLE,
    ),
    desktop: path.join(dataHome, "applications", KDE_APP_SHOT_DESKTOP),
  };
}

function cancelled(): Error {
  const error = new Error("KDE App Shot capture cancelled.");
  error.name = "AbortError";
  return error;
}
function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function dimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 1_000_000
  );
}
function bounds(value: unknown): value is KdeAppShotBounds {
  return (
    isRecord(value) &&
    ["x", "y"].every(
      (key) =>
        Number.isSafeInteger(value[key]) &&
        Math.abs(Number(value[key])) <= 1_000_000,
    ) &&
    dimension(value.width) &&
    dimension(value.height)
  );
}
function windowIdentity(value: unknown): value is KdeAppShotWindow {
  return (
    isRecord(value) &&
    ["id", "title", "appName", "appIdentifier"].every(
      (key) =>
        typeof value[key] === "string" && (value[key] as string).length <= 4096,
    ) &&
    (value.id as string).length > 0 &&
    Number.isSafeInteger(value.processId) &&
    Number(value.processId) >= 0 &&
    Number(value.processId) <= 0xffff_ffff &&
    bounds(value.bounds) &&
    bounds(value.clientBounds)
  );
}
function decodeReply(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES)
    throw new Error("Oversized KDE capture response.");
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.protocolVersion !== KDE_APP_SHOT_PROTOCOL_VERSION
  )
    throw new Error(
      "KDE capture helper protocol mismatch. Update the helper manually before capturing.",
    );
  return value;
}

function safeOwner(stat: { uid: number; mode: number }): boolean {
  return (
    (typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
    (stat.mode & 0o022) === 0
  );
}
async function regularDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !safeOwner(stat))
    throw new Error(
      "KDE helper directories must be owned by you and must not be symbolic links or writable by other users.",
    );
}
async function regularFile(file: string, executable = false): Promise<void> {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !safeOwner(stat) ||
    (executable && (stat.mode & 0o100) === 0)
  )
    throw new Error(
      "KDE helper files must be regular, user-owned files with safe permissions.",
    );
}
// Desktop Exec is not a shell command. Percent signs are escaped field codes.
function desktopExec(executable: string): string {
  // KDE first performs Desktop Entry unescaping, then Exec unquoting.
  const quoted = executable
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return (
    `"${quoted}"`.replaceAll("\\", "\\\\").replaceAll("\t", "\\t") + " check"
  );
}

async function checkInstalled(options: KdeAppShotOptions): Promise<string> {
  const paths = kdeAppShotPaths(options);
  for (const directory of [
    paths.dataHome,
    path.join(paths.dataHome, "zenx"),
    path.dirname(paths.executable),
    path.dirname(paths.desktop),
  ])
    await regularDirectory(directory);
  await regularFile(paths.executable, true);
  await regularFile(paths.desktop);
  const file = await fs.open(
    paths.desktop,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let entry: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !safeOwner(stat) || stat.size > 16 * 1024)
      throw new Error("Invalid KDE helper desktop entry.");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size)
      throw new Error("KDE helper desktop entry changed while checking.");
    entry = bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
  let section = "";
  const keys = new Map<string, string>();
  for (const line of entry.split(/\r?\n/u)) {
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section !== "[Desktop Entry]" || !line || line.startsWith("#"))
      continue;
    const equal = line.indexOf("=");
    if (equal < 1) throw new Error("Invalid KDE helper desktop entry.");
    const key = line.slice(0, equal);
    if (keys.has(key))
      throw new Error("Duplicate KDE helper desktop entry key.");
    keys.set(key, line.slice(equal + 1));
  }
  if (
    keys.get("Type") !== "Application" ||
    keys.get("Exec") !== desktopExec(paths.executable) ||
    keys.get("X-KDE-DBUS-Restricted-Interfaces") !==
      "org.kde.KWin.ScreenShot2" ||
    keys.get("X-ZenX-Capture-Helper") !== "true" ||
    keys.get("Hidden") === "true"
  )
    throw new Error(
      "KDE helper desktop entry does not match the dedicated ZenX helper. Complete manual setup.",
    );
  return paths.executable;
}

/** Wait for process close even on cancellation, then remove private capture files. */
function runHelper(
  executable: string,
  args: string[],
  options: KdeAppShotOptions,
): Promise<string> {
  checkCancellation(options.signal);
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000)
    throw new Error("Invalid KDE capture deadline.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let failure: Error | undefined;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(
      () => stop(new Error("KDE capture helper timed out.")),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      outputSize += data.length;
      if (outputSize > MAX_METADATA_BYTES)
        stop(new Error("Oversized KDE capture response."));
      else stdout.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      errorSize += data.length;
      if (errorSize > MAX_METADATA_BYTES)
        stop(new Error("Oversized KDE capture error."));
      else stderr.push(data);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      options.signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0)
        return reject(
          new Error(
            diagnostic.includes("NoAuthorized")
              ? `KDE denied capture access. ${SETUP_MESSAGE}`
              : diagnostic || "The KDE capture helper did not respond.",
          ),
        );
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    if (options.signal?.aborted) abort();
  });
}

/** Authorization probe uses an invalid window ID and /dev/null. It never captures pixels or installs anything. */
export async function getKdeAppShotSupport(
  options: KdeAppShotOptions = {},
): Promise<KdeAppShotSupport> {
  checkCancellation(options.signal);
  const common = {
    protocolVersion: KDE_APP_SHOT_PROTOCOL_VERSION,
    feedbackAvailable: false,
  } as const;
  if (process.platform !== "linux" || !isKdeSession(options.env))
    return {
      ...common,
      available: false,
      status: "unavailable",
      message: "Native KDE App Shot is unavailable in this session.",
    };
  try {
    const executable = await checkInstalled(options);
    checkCancellation(options.signal);
    const reply = decodeReply(await runHelper(executable, ["check"], options));
    if (reply.ready !== true || reply.feedbackAvailable !== false)
      throw new Error("Invalid KDE helper capability response.");
    return {
      ...common,
      available: true,
      status: "ready",
      message: "KDE App Shot capture access is ready.",
    };
  } catch (error) {
    checkCancellation(options.signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        ...common,
        available: false,
        status: "manual-setup-required",
        message: SETUP_MESSAGE,
      };
    return {
      ...common,
      available: false,
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Could not check KDE capture access.",
    };
  }
}

async function readPng(
  filePath: string,
  options: KdeAppShotOptions,
): Promise<Pick<KdeAppShotCapture, "png" | "width" | "height">> {
  checkCancellation(options.signal);
  const file = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let png: Buffer;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      !safeOwner(stat) ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size < 33 ||
      stat.size > MAX_PNG_BYTES
    )
      throw new Error("Invalid or non-private KDE screenshot file.");
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
      if (!bytesRead) throw new Error("Incomplete KDE screenshot file.");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("KDE screenshot changed while reading.");
  } finally {
    await file.close();
  }
  checkCancellation(options.signal);
  if (
    !png.subarray(0, 8).equals(PNG_HEADER) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid KDE screenshot PNG.");
  const sourceWidth = png.readUInt32BE(16),
    sourceHeight = png.readUInt32BE(20);
  if (
    !dimension(sourceWidth) ||
    !dimension(sourceHeight) ||
    sourceWidth * sourceHeight > MAX_PIXELS
  )
    throw new Error("Invalid KDE screenshot dimensions.");
  const image = options.createImage
    ? options.createImage(png)
    : (await import("electron")).nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("The KDE screenshot is empty.");
  const { width, height } = image.getSize();
  if (width !== sourceWidth || height !== sourceHeight)
    throw new Error("KDE screenshot dimensions do not match.");
  const scale = Math.min(2_560 / width, 1_600 / height, 1);
  if (scale >= 1) {
    if (png.length > MAX_OUTPUT_BYTES)
      throw new Error("KDE screenshot exceeds the image size limit.");
    return { png, width, height };
  }
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  const output = resized.toPNG();
  const size = resized.getSize();
  if (
    resized.isEmpty() ||
    !dimension(size.width) ||
    !dimension(size.height) ||
    size.width > 2_560 ||
    size.height > 1_600 ||
    output.length > MAX_OUTPUT_BYTES ||
    !output.subarray(0, 8).equals(PNG_HEADER)
  )
    throw new Error("Invalid or oversized KDE screenshot.");
  checkCancellation(options.signal);
  return { png: output, ...size };
}

/** Explicit capture only. Private scratch data is removed before returning; no alternate capture or guessed identity. */
export async function captureKdeActiveAppShot(
  options: KdeAppShotOptions = {},
): Promise<KdeAppShotCapture> {
  checkCancellation(options.signal);
  const support = await getKdeAppShotSupport(options);
  if (!support.available) throw new Error(support.message);
  const executable = await checkInstalled(options);
  checkCancellation(options.signal);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "zenx-kde-capture-"),
  );
  try {
    const reply = decodeReply(
      await runHelper(executable, ["capture", directory], options),
    );
    if (reply.window !== null && !windowIdentity(reply.window))
      throw new Error("Invalid KDE capture identity.");
    const window = reply.window as KdeAppShotWindow | null;
    if (
      window &&
      (window.processId === process.pid ||
        options.excludedPids?.includes(window.processId))
    )
      throw new Error("App Shot cannot capture its own application window.");
    const capture = await readPng(path.join(directory, "capture.png"), options);
    checkCancellation(options.signal);
    return { ...capture, ...(window ? { window } : {}) };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
