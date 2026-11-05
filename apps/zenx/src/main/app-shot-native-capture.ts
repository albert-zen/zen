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

import { fork as nodeFork } from "node:child_process";

import {
  APP_SHOT_MAX_PNG_BYTES,
  APP_SHOT_MAX_PIXELS,
  APP_SHOT_MAX_TEXT,
  isRecord,
  isAppShotBounds,
  isAppShotIdentity,
  isAppShotAccessibilityIdentity,
  sameAppShotIdentity,
  type AppShotBounds,
  type AppShotCaptureIdentity,
  type AppShotAccessibilityIdentity,
  type AppShotText,
} from "./app-shot-native-contract.js";
export * from "./app-shot-native-contract.js";

export type AppShotNativeOperation = "foreground" | "region" | "accessibility";

export interface AppShotNativeChild {
  send(request: unknown, callback: (error?: Error | null) => void): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: () => void): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export interface AppShotNativeRunOptions {
  /** Absolute emitted worker path, supplied by the trusted Electron adapter. */
  workerPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Grace per shutdown phase; a result is not accepted before child exit. */
  shutdownGraceMs?: number;
  fork?: (operation: AppShotNativeOperation) => AppShotNativeChild;
}

function forkNativeChild(
  operation: AppShotNativeOperation,
  workerPath: string,
): AppShotNativeChild {
  const child = nodeFork(workerPath, [operation], {
    // On macOS the default Electron Helper does not inherit the main app AX grant.
    execPath: process.execPath,
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return {
    send: (request, callback) => child.send(request as object, callback),
    onMessage: (listener) => {
      child.on("message", listener);
    },
    onExit: (listener) => {
      // Spawn errors also produce close; an error alone is not proof of exit.
      child.once("error", () => {});
      child.once("close", listener);
    },
    kill: (signal = "SIGTERM") => {
      child.kill(signal);
    },
  };
}

/** One request per child. Startup, stalls, crashes and cancellation all dispose it. */
export function runAppShotNative(
  operation: AppShotNativeOperation,
  request: unknown,
  options: AppShotNativeRunOptions = {},
): Promise<unknown> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("App Shot cancelled"));
  return new Promise((resolve, reject) => {
    let child: AppShotNativeChild;
    try {
      if (!options.fork && !options.workerPath)
        throw new Error("Missing App Shot worker path");
      child = options.fork
        ? options.fork(operation)
        : forkNativeChild(operation, options.workerPath!);
    } catch {
      reject(new Error("App Shot native helper is unavailable"));
      return;
    }
    let finishing = false;
    let completed = false;
    let exited = false;
    let sent = false;
    let failure: Error | undefined;
    let result: unknown;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    const shutdownGraceMs = options.shutdownGraceMs ?? 500;
    const timeout = setTimeout(
      () => finish(new Error("App Shot native helper timed out")),
      options.timeoutMs ??
        (operation === "region"
          ? 15_000
          : operation === "accessibility"
            ? 4_000
            : 2_000),
    );
    const onAbort = () => {
      if (completed) return;
      if (finishing) {
        failure ??= new Error("App Shot cancelled");
        result = undefined;
      } else finish(new Error("App Shot cancelled"));
    };
    function complete(unconfirmed = false) {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      clearTimeout(shutdownTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (unconfirmed)
        failure = new Error(
          (failure?.message ?? "App Shot native operation failed") +
            "; helper shutdown could not be confirmed",
        );
      if (failure) reject(failure);
      else resolve(result);
    }
    function finish(error?: Error, value?: unknown) {
      if (finishing) return;
      finishing = true;
      failure = error;
      result = value;
      clearTimeout(timeout);
      if (exited) {
        complete();
        return;
      }
      // Fence all output now, but do not report success/cleanup before exit.
      shutdownTimer = setTimeout(() => {
        shutdownTimer = setTimeout(() => complete(true), shutdownGraceMs);
        try {
          child.kill("SIGKILL");
        } catch {
          /* Await close or report unconfirmed shutdown. */
        }
      }, shutdownGraceMs);
      try {
        child.kill("SIGTERM");
      } catch {
        /* Escalate only this owned child. */
      }
    }
    child.onMessage((message) => {
      if (finishing) return;
      if (message === "ready") {
        if (sent) return;
        sent = true;
        try {
          child.send(request, (error) => {
            if (error) finish(new Error("App Shot native request failed"));
          });
        } catch {
          finish(new Error("App Shot native request failed"));
        }
        return;
      }
      if (!sent || !isRecord(message))
        return finish(
          new Error("App Shot native helper returned invalid data"),
        );
      if (message.type === "result") finish(undefined, message.value);
      else finish(new Error("App Shot native operation failed"));
    });
    child.onExit(() => {
      exited = true;
      if (finishing) complete();
      else finish(new Error("App Shot native helper exited"));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

export async function readWindowsAppShotForeground(
  options: AppShotNativeRunOptions = {},
): Promise<AppShotCaptureIdentity> {
  const value = await runAppShotNative("foreground", {}, options);
  if (!isAppShotIdentity(value) || value.platform !== "win32")
    throw new Error("Foreground window identity is unavailable");
  return value;
}

export interface AppShotRegionImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Fail before decoding oversized IPC output; verify PNG dimensions against the receipt. */
export function parseAppShotRegionImage(value: unknown): AppShotRegionImage {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Number(value.width) <= 0 ||
    Number(value.height) <= 0 ||
    Number(value.width) * Number(value.height) > APP_SHOT_MAX_PIXELS ||
    typeof value.png !== "string" ||
    value.png.length > Math.ceil(APP_SHOT_MAX_PNG_BYTES / 3) * 4 ||
    value.png.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.png)
  )
    throw new Error("App Shot returned invalid image data");
  const png = Buffer.from(value.png, "base64");
  if (
    png.length < 33 ||
    png.length > APP_SHOT_MAX_PNG_BYTES ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    png.readUInt32BE(16) !== value.width ||
    png.readUInt32BE(20) !== value.height
  )
    throw new Error("App Shot returned invalid PNG dimensions");
  return { png, width: Number(value.width), height: Number(value.height) };
}

export async function captureAppShotRegion(
  region: AppShotBounds,
  options: AppShotNativeRunOptions = {},
): Promise<AppShotRegionImage> {
  if (!isAppShotBounds(region))
    throw new Error("App Shot capture region is invalid");
  return parseAppShotRegionImage(
    await runAppShotNative("region", { region }, options),
  );
}

/**
 * Optional text only. Linux revalidates the AX object, not compositor state.
 * macOS/Windows callers must revalidate the native capture identity afterward.
 */
export async function readCapturedAppShotAccessibility(
  identity: AppShotAccessibilityIdentity,
  options: AppShotNativeRunOptions = {},
): Promise<AppShotText | undefined> {
  if (!isAppShotAccessibilityIdentity(identity)) return undefined;
  try {
    const value = await runAppShotNative(
      "accessibility",
      { identity },
      options,
    );
    if (
      !isRecord(value) ||
      typeof value.text !== "string" ||
      value.text.length > APP_SHOT_MAX_TEXT ||
      typeof value.truncated !== "boolean"
    )
      return undefined;
    return value.text
      ? { text: value.text, truncated: value.truncated }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AppShotWindowsCaptureDependencies {
  getForeground(): Promise<AppShotCaptureIdentity>;
  screenToDipRect(
    window: null,
    bounds: AppShotBounds,
  ): AppShotBounds | Promise<AppShotBounds>;
  captureRegion(region: AppShotBounds): Promise<AppShotRegionImage>;
  readAccessibility(
    identity: AppShotCaptureIdentity,
  ): Promise<AppShotText | undefined>;
}

export interface AppShotWindowsCapture extends AppShotRegionImage {
  identity: AppShotCaptureIdentity;
  /** Visible desktop region at the window bounds, NOT an HWND surface capture. */
  captureKind: "screen-region";
  region: AppShotBounds;
  accessibility?: AppShotText;
}

export async function captureWindowsActiveAppShot(
  options: {
    workerPath?: string;
    includeAccessibility?: boolean;
    excludedWindowIds?: readonly number[];
    signal?: AbortSignal;
  } = {},
  injected?: AppShotWindowsCaptureDependencies,
): Promise<AppShotWindowsCapture> {
  if (options.signal?.aborted) throw new Error("App Shot cancelled");
  const dependencies = injected ?? {
    getForeground: () =>
      readWindowsAppShotForeground({
        signal: options.signal,
        workerPath: options.workerPath,
      }),
    screenToDipRect: async (_window: null, bounds: AppShotBounds) =>
      (await import("electron")).screen.screenToDipRect(null, bounds),
    captureRegion: (region: AppShotBounds) =>
      captureAppShotRegion(region, {
        signal: options.signal,
        workerPath: options.workerPath,
      }),
    readAccessibility: (identity: AppShotCaptureIdentity) =>
      readCapturedAppShotAccessibility(identity, {
        signal: options.signal,
        workerPath: options.workerPath,
      }),
  };
  const active = await dependencies.getForeground();
  if (
    !isAppShotIdentity(active) ||
    active.platform !== "win32" ||
    active.pid === process.pid ||
    options.excludedWindowIds?.includes(active.windowId)
  )
    throw new Error(
      "App Shot requires an identified external foreground window",
    );
  // Bound physical pixels before the worker converts logical coordinates back.
  if (active.bounds.width * active.bounds.height > APP_SHOT_MAX_PIXELS)
    throw new Error("App Shot image exceeds the pixel budget");
  const region = await dependencies.screenToDipRect(null, active.bounds);
  if (!isAppShotBounds(region))
    throw new Error("App Shot capture region is invalid");
  // Reject a switch while converting DPI coordinates, before collecting any pixels.
  if (!sameAppShotIdentity(active, await dependencies.getForeground()))
    throw new Error("Active window changed before App Shot");
  const image = await dependencies.captureRegion(region);
  if (!sameAppShotIdentity(active, await dependencies.getForeground()))
    throw new Error("Active window changed during App Shot");
  let accessibility: AppShotText | undefined;
  if (options.includeAccessibility) {
    // xa11y UIA bounds are logical; native foreground identity stays physical.
    try {
      accessibility = await dependencies.readAccessibility({
        ...active,
        bounds: region,
      });
    } catch {
      /* Optional text. */
    }
    if (!sameAppShotIdentity(active, await dependencies.getForeground()))
      throw new Error("Active window changed during App Shot");
  }
  if (options.signal?.aborted) throw new Error("App Shot cancelled");
  return {
    ...image,
    identity: active,
    captureKind: "screen-region",
    region,
    ...(accessibility ? { accessibility } : {}),
  };
}
