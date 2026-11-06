/**
 * Niri capture transport and identity checks adapted from T3 Code:
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/NiriSnapShot.ts
 * PNG bounds adapted from the same revision's linuxCaptureSession.ts.
 *
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface NiriWindow {
  id: number;
  title: string | null;
  app_id: string | null;
  pid: number | null;
  layout: { window_size: [number, number] };
}

export interface NiriAppShotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: "best";
  }): NiriAppShotImage;
  toPNG(): Buffer;
}

export interface NiriAppShotCapture {
  png: Buffer;
  width: number;
  height: number;
  /** Present only when the captured window's identity still matches. */
  window?: {
    id: number;
    pid: number | null;
    title: string | null;
    appId: string | null;
    bounds: { x: number; y: number; width: number; height: number };
    /** Niri supplies logical size, not a globally comparable screen origin. */
    accessibilityBoundsReliable: false;
  };
}

export interface NiriAppShotOptions {
  /** Main-process only. Never accept a socket path from the renderer. */
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Host-owned extra process exclusions; the ZenX main PID is always excluded. */
  excludedPids?: readonly number[];
  /** Native-image boundary for synthetic transport tests; Electron by default. */
  createImage?: (png: Buffer) => NiriAppShotImage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Explicit equivalents of upstream's bounded Window/Reply/event schemas. */
function isWindow(value: unknown): value is NiriWindow {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isNullableString(value.title) ||
    !isNullableString(value.app_id) ||
    !(value.pid === null || isSize(value.pid)) ||
    !isRecord(value.layout)
  )
    return false;
  const size = value.layout.window_size;
  return (
    Array.isArray(size) &&
    size.length === 2 &&
    isSize(size[0]) &&
    isSize(size[1])
  );
}

function invalidResponse(): never {
  throw new Error("Niri returned an invalid response.");
}

function decodeReply(value: unknown): { Ok: unknown } | { Err: string } {
  if (!isRecord(value)) return invalidResponse();
  if (Object.hasOwn(value, "Ok")) return { Ok: value.Ok };
  if (typeof value.Err === "string") return { Err: value.Err };
  return invalidResponse();
}

function decodeFocused(value: unknown): { FocusedWindow: NiriWindow | null } {
  if (
    !isRecord(value) ||
    !(value.FocusedWindow === null || isWindow(value.FocusedWindow))
  )
    return invalidResponse();
  return { FocusedWindow: value.FocusedWindow };
}

function decodeWindows(value: unknown): { Windows: NiriWindow[] } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.Windows) ||
    !value.Windows.every(isWindow)
  )
    return invalidResponse();
  return { Windows: value.Windows };
}

function decodeVersion(value: unknown): { Version: string } {
  if (!isRecord(value) || typeof value.Version !== "string")
    return invalidResponse();
  return { Version: value.Version };
}

function isWindowsChanged(
  value: unknown,
): value is { WindowsChanged: { windows: NiriWindow[] } } {
  return (
    isRecord(value) &&
    isRecord(value.WindowsChanged) &&
    Array.isArray(value.WindowsChanged.windows) &&
    value.WindowsChanged.windows.every(isWindow)
  );
}

function isScreenshotCaptured(
  value: unknown,
): value is { ScreenshotCaptured: { path: string | null } } {
  return (
    isRecord(value) &&
    isRecord(value.ScreenshotCaptured) &&
    isNullableString(value.ScreenshotCaptured.path)
  );
}

export function isNiriSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    !env.FLATPAK_ID &&
    !env.SNAP &&
    Boolean(
      env.XDG_CURRENT_DESKTOP?.split(":").some(
        (name) => name.toLowerCase() === "niri",
      ),
    )
  );
}

/** A stale NIRI_SOCKET outside the actual Niri desktop is not availability. */
export function niriSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isNiriSession(env)) return undefined;
  return env.NIRI_SOCKET && NodePath.isAbsolute(env.NIRI_SOCKET)
    ? env.NIRI_SOCKET
    : undefined;
}

function captureCancelled(): Error {
  const error = new Error("Niri App Shot capture cancelled.");
  error.name = "AbortError";
  return error;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw captureCancelled();
}

class NiriConnection {
  private readonly socket: NodeNet.Socket;
  private readonly listeners = new Set<(value: unknown) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private failure: Error | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly abort = () => this.close(captureCancelled());

  constructor(path: string, signal?: AbortSignal) {
    checkCancellation(signal);
    this.signal = signal;
    this.socket = NodeNet.createConnection(path);
    this.socket.setEncoding("utf8");
    let pending = "";
    this.socket.on("data", (chunk: string) => {
      pending += chunk;
      // Bound even an unterminated or malicious reply; ignore unrelated events without retaining them.
      if (Buffer.byteLength(pending) > MAX_MESSAGE_BYTES) {
        this.close(new Error("Niri returned an oversized message."));
        return;
      }
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          for (const listener of this.listeners) listener(value);
        } catch {
          this.close(new Error("Niri returned an invalid message."));
          return;
        }
      }
    });
    this.socket.on("error", (error) => this.close(error));
    this.socket.on("close", () => this.close(new Error("Niri disconnected.")));
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  waitFor<T>(select: (value: unknown) => T | undefined): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.failures.delete(fail);
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      const listener = (value: unknown) => {
        try {
          const selected = select(value);
          if (selected !== undefined) {
            finish();
            resolve(selected);
          }
        } catch (error) {
          fail(
            error instanceof Error ? error : new Error("Invalid Niri reply."),
          );
        }
      };
      const timer = setTimeout(
        () => fail(new Error("Niri snapshot timed out.")),
        TIMEOUT_MS,
      );
      this.listeners.add(listener);
      this.failures.add(fail);
    });
  }

  send(request: unknown) {
    this.socket.write(`${JSON.stringify(request)}\n`);
  }

  close(error = new Error("Niri connection closed.")) {
    if (this.failure) return;
    this.failure = error;
    this.signal?.removeEventListener("abort", this.abort);
    for (const fail of this.failures) fail(error);
    this.socket.destroy();
  }
}

async function request(
  path: string,
  message: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const connection = new NiriConnection(path, signal);
  try {
    const reply = connection.waitFor((value) => ({
      value: decodeReply(value),
    }));
    connection.send(message);
    const { value } = await reply;
    if ("Err" in value) throw new Error(`Niri: ${value.Err}`);
    return value.Ok;
  } finally {
    connection.close();
  }
}

export async function checkNiriCaptureSupport(
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const version = decodeVersion(await request(path, "Version", signal)).Version;
  // 25.11 introduced both caller-selected screenshot paths and completion events.
  const match = /^(?:niri )?(\d+)\.(\d+)/.exec(version);
  if (
    !match ||
    Number(match[1]) < 25 ||
    (Number(match[1]) === 25 && Number(match[2]) < 11)
  )
    throw new Error("App Shot requires Niri 25.11 or newer.");
}

async function readNiriPng(
  path: string,
  createImage?: NiriAppShotOptions["createImage"],
  signal?: AbortSignal,
): Promise<Pick<NiriAppShotCapture, "png" | "width" | "height">> {
  checkCancellation(signal);
  const file = await NodeFSP.open(path, "r");
  let png: Buffer;
  try {
    const stat = await file.stat();
    checkCancellation(signal);
    if (!stat.isFile() || stat.size > MAX_PNG_BYTES)
      throw new Error("Invalid screenshot file.");
    png = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < png.length) {
      checkCancellation(signal);
      const { bytesRead } = await file.read(
        png,
        offset,
        png.length - offset,
        offset,
      );
      if (!bytesRead) throw new Error("Incomplete screenshot file.");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  checkCancellation(signal);
  if (!png.subarray(0, 8).equals(PNG_HEADER))
    throw new Error("Invalid or oversized window screenshot.");
  const image = createImage
    ? createImage(png)
    : (await import("electron")).nativeImage.createFromBuffer(png);
  checkCancellation(signal);
  if (image.isEmpty()) throw new Error("The window screenshot is empty.");
  const { width, height } = image.getSize();
  if (!isSize(width) || !isSize(height))
    throw new Error("Invalid window screenshot dimensions.");
  const scale = Math.min(2_560 / width, 1_600 / height, 1);
  if (scale >= 1) {
    if (png.length > MAX_OUTPUT_BYTES)
      throw new Error("Window screenshot exceeds the image size limit.");
    return { png, width, height };
  }
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "best",
  });
  if (resized.isEmpty()) throw new Error("The window screenshot is empty.");
  const resizedPng = resized.toPNG();
  checkCancellation(signal);
  const size = resized.getSize();
  if (
    resizedPng.length > MAX_OUTPUT_BYTES ||
    !resizedPng.subarray(0, 8).equals(PNG_HEADER) ||
    !isSize(size.width) ||
    !isSize(size.height) ||
    size.width > 2_560 ||
    size.height > 1_600
  )
    throw new Error("Invalid or oversized window screenshot.");
  return { png: resizedPng, ...size };
}

/**
 * Read a single exact foreground window using Niri >=25.11.
 * No focus/input, shortcut registration, configuration writes, accessibility
 * read, attachment persistence, model delivery, or alternate capture fallback.
 */
export async function captureNiriActiveAppShot(
  options: NiriAppShotOptions = {},
): Promise<NiriAppShotCapture> {
  checkCancellation(options.signal);
  const path = options.socketPath ?? niriSocketPath(options.env);
  if (!path || !NodePath.isAbsolute(path))
    throw new Error("Native Niri App Shot is unavailable in this session.");
  await checkNiriCaptureSupport(path, options.signal);
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "zenx-niri-capture-"),
  );
  const imagePath = NodePath.join(directory, "capture.png");
  let events: NiriConnection | undefined;
  try {
    events = new NiriConnection(path, options.signal);
    // Initial state proves subscription; the EventStream reply alone does not.
    const ready = events.waitFor((value) =>
      isWindowsChanged(value) ? true : undefined,
    );
    events.send("EventStream");
    await ready;
    const window = decodeFocused(
      await request(path, "FocusedWindow", options.signal),
    ).FocusedWindow;
    if (!window) throw new Error("Niri has no focused window to capture.");
    if (
      window.pid !== null &&
      (window.pid === process.pid || options.excludedPids?.includes(window.pid))
    )
      throw new Error("App Shot cannot capture its own application window.");
    const captured = events.waitFor((value) =>
      isScreenshotCaptured(value) && value.ScreenshotCaptured.path === imagePath
        ? true
        : undefined,
    );
    // Observe rejection if the command is rejected before awaiting its event.
    void captured.catch(() => undefined);
    await request(
      path,
      {
        Action: {
          ScreenshotWindow: {
            id: window.id,
            write_to_disk: true,
            show_pointer: false,
            path: imagePath,
          },
        },
      },
      options.signal,
    );
    await captured;
    const image = await readNiriPng(
      imagePath,
      options.createImage,
      options.signal,
    );
    const after = decodeWindows(
      await request(path, "Windows", options.signal),
    ).Windows.find((item) => item.id === window.id);
    // Changed/closed windows still yield pixels, never text from a replacement.
    const identityUnchanged =
      after &&
      after.pid === window.pid &&
      after.title === window.title &&
      after.app_id === window.app_id &&
      after.layout.window_size.every(
        (size, i) => size === window.layout.window_size[i],
      );
    checkCancellation(options.signal);
    return {
      ...image,
      ...(identityUnchanged
        ? {
            window: {
              id: window.id,
              pid: window.pid,
              title: window.title,
              appId: window.app_id,
              bounds: {
                x: 0,
                y: 0,
                width: window.layout.window_size[0],
                height: window.layout.window_size[1],
              },
              accessibilityBoundsReliable: false as const,
            },
          }
        : {}),
    };
  } finally {
    events?.close();
    // Only our private capture directory is removed, never an event's path.
    // An accepted compositor request cannot be undone: a late write may fail
    // or recreate a private file after cancellation and this cleanup.
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
