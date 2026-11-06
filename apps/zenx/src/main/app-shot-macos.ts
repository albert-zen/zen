/*
 * Adapted from T3 Code at 337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17.
 * MIT License
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
 */

// Exact-window command and image resizing follow upstream MacSnapShot.ts.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_SHOT_MAX_PNG_BYTES,
  APP_SHOT_MAX_PIXELS,
  isAppShotIdentity,
  sameAppShotIdentity,
} from "./app-shot-native-contract.js";
import {
  readMacWindowMetadata,
  type AppShotActiveWindow,
} from "./app-shot-native.js";
import type { NiriAppShotImage } from "./app-shot-niri.js";

interface MacAppShotChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: "SIGKILL"): boolean;
}

/** Trusted host/test seams only; none are accepted from the renderer. */
export interface MacAppShotOptions {
  signal?: AbortSignal;
  excludedWindowIds?: () => readonly number[];
  readMetadata?: (windowId: number) => Promise<AppShotActiveWindow>;
  createImage?: (png: Buffer) => NiriAppShotImage;
  tempRoot?: string;
  filesystem?: Pick<typeof fs, "mkdtemp" | "chmod" | "open" | "rm">;
  spawn?: (
    file: string,
    args: string[],
    options: { shell: false; stdio: "ignore" },
  ) => MacAppShotChild;
  timeoutMs?: number;
  shutdownGraceMs?: number;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("App Shot cancelled");
}

/** A failed close cannot authorize deleting a file the child may still write. */
class UnconfirmedMacCapture extends Error {
  constructor(
    readonly closed: Promise<void>,
    reason: string,
  ) {
    super(
      `${reason}; capture process shutdown and temporary-file cleanup could not be confirmed`,
    );
  }
}

function runCapture(
  windowId: number,
  outputPath: string,
  options: MacAppShotOptions,
): Promise<void> {
  checkCancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(
      "/usr/sbin/screencapture",
      ["-l", String(windowId), "-o", "-x", "-t", "png", outputPath],
      { shell: false, stdio: "ignore" },
    );
    let failure: Error | undefined;
    let finished = false;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    let confirmClose!: () => void;
    const closed = new Promise<void>((resolveClose) => {
      confirmClose = resolveClose;
    });
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(shutdown);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function stop(error: Error) {
      if (failure || finished) return;
      failure = error;
      clearTimeout(deadline);
      shutdown = setTimeout(
        () => finish(new UnconfirmedMacCapture(closed, error.message)),
        options.shutdownGraceMs ?? 1000,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        /* Only close proves the owned child is done. */
      }
    }
    const abort = () => stop(new Error("App Shot cancelled"));
    const deadline = setTimeout(
      () => stop(new Error("macOS App Shot timed out")),
      options.timeoutMs ?? 15_000,
    );
    child.once("error", () =>
      stop(new Error("macOS App Shot capture process failed")),
    );
    child.once("close", (code) => {
      confirmClose();
      finish(
        failure ??
          (code === 0
            ? undefined
            : new Error(
                "macOS App Shot failed; check Screen Recording permission and choose the window again",
              )),
      );
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function pngSize(png: Buffer): { width: number; height: number } {
  if (
    png.length < 33 ||
    png.length > APP_SHOT_MAX_PNG_BYTES ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("macOS App Shot returned an invalid or oversized PNG");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > APP_SHOT_MAX_PIXELS
  )
    throw new Error(
      "macOS App Shot returned invalid or oversized image dimensions",
    );
  return { width, height };
}

async function readPng(
  path: string,
  options: MacAppShotOptions,
): Promise<Buffer> {
  const file = await (options.filesystem ?? fs).open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 33 ||
      stat.size > APP_SHOT_MAX_PNG_BYTES
    )
      throw new Error(
        "macOS App Shot returned an invalid or oversized image file",
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      checkCancelled(options.signal);
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead)
        throw new Error("macOS App Shot returned an incomplete image file");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== stat.size)
      throw new Error("macOS App Shot image file changed while reading");
    return bytes;
  } finally {
    await file.close();
  }
}

/** One CG window surface, never a screen rectangle, all-window thumbnail or retry. */
export async function captureMacAppShotWindow(
  expected: AppShotActiveWindow,
  options: MacAppShotOptions = {},
): Promise<Buffer> {
  checkCancelled(options.signal);
  const identity = {
    ...expected,
    bounds: expected.bounds ? { ...expected.bounds } : undefined,
    platform: "darwin" as const,
  };
  if (
    !isAppShotIdentity(identity) ||
    identity.windowId > 0xffff_ffff ||
    identity.pid === process.pid
  )
    throw new Error(
      "macOS App Shot requires exact external window PID, title and bounds",
    );
  const validate = async () => {
    checkCancelled(options.signal);
    const fresh = await (options.readMetadata ?? readMacWindowMetadata)(
      identity.windowId,
    );
    checkCancelled(options.signal);
    if (
      !sameAppShotIdentity(identity, {
        ...fresh,
        platform: "darwin",
        bounds: fresh.bounds!,
      })
    )
      throw new Error("Selected window changed during App Shot");
    if (options.excludedWindowIds?.().includes(identity.windowId))
      throw new Error("App Shot cannot capture its own window");
  };
  // Reject missing/reused/own metadata before creating even a temporary directory.
  await validate();
  const files = options.filesystem ?? fs;
  const directory = await files.mkdtemp(
    join(options.tempRoot ?? tmpdir(), "zenx-app-shot-mac-"),
  );
  let unconfirmed: Promise<void> | undefined;
  const cleanup = () => files.rm(directory, { recursive: true, force: true });
  let result: Buffer;
  try {
    await files.chmod(directory, 0o700);
    // Re-read after asynchronous setup, immediately before asking for pixels.
    await validate();
    try {
      await runCapture(
        identity.windowId,
        join(directory, "window.png"),
        options,
      );
    } catch (error) {
      if (error instanceof UnconfirmedMacCapture) unconfirmed = error.closed;
      throw error;
    }
    await validate();
    const captured = await readPng(join(directory, "window.png"), options);
    const size = pngSize(captured); // Bound compressed bytes and dimensions BEFORE native decode.
    checkCancelled(options.signal);
    const image = options.createImage
      ? options.createImage(captured)
      : (await import("electron")).nativeImage.createFromBuffer(captured);
    checkCancelled(options.signal);
    if (
      image.isEmpty() ||
      image.getSize().width !== size.width ||
      image.getSize().height !== size.height
    )
      throw new Error("macOS App Shot returned an invalid image");
    const scale = Math.min(2560 / size.width, 1600 / size.height, 1);
    if (scale < 1) {
      const dimensions = {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      };
      const resized = image.resize({ ...dimensions, quality: "best" });
      result = resized.toPNG();
      const outputSize = pngSize(result);
      if (
        resized.isEmpty() ||
        resized.getSize().width !== dimensions.width ||
        resized.getSize().height !== dimensions.height ||
        outputSize.width !== dimensions.width ||
        outputSize.height !== dimensions.height
      )
        throw new Error(
          "macOS App Shot returned invalid resized image dimensions",
        );
    } else result = captured;
    await validate();
  } finally {
    if (unconfirmed) {
      // One close-bound cleanup, no persisted retry/recovery state or unsafe early unlink.
      void unconfirmed.then(cleanup).catch(() => {});
    } else {
      try {
        await cleanup();
      } catch {
        throw new Error(
          "macOS App Shot temporary-file cleanup failed; capture was discarded",
        );
      }
    }
  }
  checkCancelled(options.signal);
  return result;
}
