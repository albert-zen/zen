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

import type {
  AppShotBounds,
  AppShotCaptureIdentity,
} from "./app-shot-native-contract.js";

/** Read operations only. No focus, keyboard, pointer or permission methods. */
export interface AppShotWindowsApi {
  getForegroundWindow(): bigint;
  getWindowText(window: bigint): string;
  getWindowRect(window: bigint): AppShotBounds | undefined;
  getWindowThreadAndProcessId(window: bigint): {
    threadId: number;
    processId: number;
  };
  getProcessImagePath(processId: number): string;
}

let apiPromise: Promise<AppShotWindowsApi> | undefined;

/** Imported only inside the disposable native worker, never during main startup. */
export function loadAppShotWindowsApi(): Promise<AppShotWindowsApi> {
  apiPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const kernel32 = "zenx-app-shot-kernel32";
    const user32 = "zenx-app-shot-user32";
    open({ library: kernel32, path: "kernel32.dll" });
    open({ library: user32, path: "user32.dll" });
    return {
      getForegroundWindow: () =>
        load({
          library: user32,
          funcName: "GetForegroundWindow",
          retType: DataType.BigInt,
          paramsType: [],
          paramsValue: [],
        }) as bigint,
      getWindowText: (window) => {
        const buffer = Buffer.alloc(2 * 1024);
        const length = load({
          library: user32,
          funcName: "GetWindowTextW",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U8Array, DataType.I32],
          paramsValue: [window, buffer, buffer.byteLength / 2],
        });
        return length > 0
          ? buffer.subarray(0, length * 2).toString("utf16le")
          : "";
      },
      getWindowRect: (window) => {
        const rect = Buffer.alloc(16);
        const ok = load({
          library: user32,
          funcName: "GetWindowRect",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [window, rect],
        });
        if (!ok) return undefined;
        const x = rect.readInt32LE(0);
        const y = rect.readInt32LE(4);
        return {
          x,
          y,
          width: Math.max(0, rect.readInt32LE(8) - x),
          height: Math.max(0, rect.readInt32LE(12) - y),
        };
      },
      getWindowThreadAndProcessId: (window) => {
        const out = Buffer.alloc(4);
        const threadId = load({
          library: user32,
          funcName: "GetWindowThreadProcessId",
          retType: DataType.U32,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [window, out],
        });
        return { threadId, processId: out.readUInt32LE(0) };
      },
      getProcessImagePath: (processId) => {
        const handle = load({
          library: kernel32,
          funcName: "OpenProcess",
          retType: DataType.BigInt,
          paramsType: [DataType.U32, DataType.Boolean, DataType.U32],
          paramsValue: [0x1000, false, processId],
        }) as bigint;
        if (handle === 0n) return "";
        try {
          const buffer = Buffer.alloc(2 * 32_768);
          const size = Buffer.alloc(4);
          size.writeUInt32LE(buffer.byteLength / 2, 0);
          const ok = load({
            library: kernel32,
            funcName: "QueryFullProcessImageNameW",
            retType: DataType.Boolean,
            paramsType: [
              DataType.BigInt,
              DataType.U32,
              DataType.U8Array,
              DataType.U8Array,
            ],
            paramsValue: [handle, 0, buffer, size],
          });
          return ok
            ? buffer.subarray(0, size.readUInt32LE(0) * 2).toString("utf16le")
            : "";
        } finally {
          load({
            library: kernel32,
            funcName: "CloseHandle",
            retType: DataType.Boolean,
            paramsType: [DataType.BigInt],
            paramsValue: [handle],
          });
        }
      },
    } satisfies AppShotWindowsApi;
  });
  return apiPromise;
}

export function readAppShotWindowsForegroundWithApi(
  api: AppShotWindowsApi,
): AppShotCaptureIdentity {
  const handle = api.getForegroundWindow();
  const windowId = Number(handle);
  if (handle === 0n || !Number.isSafeInteger(windowId) || windowId <= 0)
    throw new Error("Foreground window identity is unavailable");
  const bounds = api.getWindowRect(handle);
  const { processId: pid } = api.getWindowThreadAndProcessId(handle);
  const windowTitle = api.getWindowText(handle);
  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    pid <= 0 ||
    !windowTitle.trim()
  )
    throw new Error("Foreground window metadata is unavailable");
  const applicationName = api.getProcessImagePath(pid).split(/[\\/]/u).pop();
  // A foreground switch while reading the row invalidates it; never retarget.
  if (api.getForegroundWindow() !== handle)
    throw new Error("Foreground window changed during identification");
  return {
    platform: "win32",
    windowId,
    windowTitle,
    pid,
    bounds,
    ...(applicationName ? { applicationName } : {}),
  };
}
