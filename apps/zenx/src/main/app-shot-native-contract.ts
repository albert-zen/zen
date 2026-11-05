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

export interface AppShotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Host-private observation, never a selector or Computer capability. */
export interface AppShotCaptureIdentity {
  platform: "win32" | "darwin";
  windowId: number;
  windowTitle: string;
  pid: number;
  bounds: AppShotBounds;
  applicationName?: string;
}

/** Wayland may supply logical size without a global screen position. */
export interface AppShotAccessibilityBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/** Only trusted compositor metadata can create this identity, never portal pixels. */
export interface AppShotLinuxCaptureIdentity {
  platform: "linux";
  matchMode: "wayland" | "screen-bounds";
  /** Preserve a compositor ID when supplied; GNOME does not supply one. */
  windowId?: number;
  windowTitle: string;
  pid: number;
  bounds: AppShotAccessibilityBounds;
  clientBounds?: AppShotAccessibilityBounds;
  applicationName?: string;
}

export type AppShotAccessibilityIdentity =
  AppShotCaptureIdentity | AppShotLinuxCaptureIdentity;

export const APP_SHOT_MAX_TEXT = 32_000;
export const APP_SHOT_MAX_NODES = 10_000;
export const APP_SHOT_MAX_PNG_BYTES = 20 * 1024 * 1024;
export const APP_SHOT_MAX_PIXELS = 64 * 1024 * 1024;

export interface AppShotText {
  text: string;
  truncated: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAppShotBounds(value: unknown): value is AppShotBounds {
  if (!isRecord(value)) return false;
  return (
    ["x", "y", "width", "height"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        Math.abs(value[key] as number) <= 1_000_000,
    ) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
  );
}

export function isAppShotIdentity(
  value: unknown,
): value is AppShotCaptureIdentity {
  return (
    isRecord(value) &&
    (value.platform === "win32" || value.platform === "darwin") &&
    Number.isSafeInteger(value.windowId) &&
    Number(value.windowId) > 0 &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.windowTitle === "string" &&
    value.windowTitle.trim().length > 0 &&
    value.windowTitle.length <= 4096 &&
    isAppShotBounds(value.bounds) &&
    (value.applicationName === undefined ||
      (typeof value.applicationName === "string" &&
        value.applicationName.length <= 4096))
  );
}

function isAccessibilityBounds(
  value: unknown,
): value is AppShotAccessibilityBounds {
  if (!isRecord(value)) return false;
  return (
    ["width", "height"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        value[key] > 0 &&
        value[key] <= 1_000_000,
    ) &&
    ((value.x === undefined && value.y === undefined) || isAppShotBounds(value))
  );
}

export function isAppShotAccessibilityIdentity(
  value: unknown,
): value is AppShotAccessibilityIdentity {
  if (isAppShotIdentity(value)) return true;
  if (!isRecord(value) || value.platform !== "linux") return false;
  const validBounds =
    value.matchMode === "wayland"
      ? isAccessibilityBounds
      : value.matchMode === "screen-bounds"
        ? isAppShotBounds
        : undefined;
  return (
    validBounds !== undefined &&
    (value.windowId === undefined ||
      (Number.isSafeInteger(value.windowId) && Number(value.windowId) >= 0)) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.windowTitle === "string" &&
    value.windowTitle.trim().length > 0 &&
    value.windowTitle.length <= 4096 &&
    validBounds(value.bounds) &&
    (value.clientBounds === undefined || validBounds(value.clientBounds)) &&
    (value.applicationName === undefined ||
      (typeof value.applicationName === "string" &&
        value.applicationName.length <= 4096))
  );
}

export function sameAppShotIdentity(
  a: AppShotCaptureIdentity,
  b: AppShotCaptureIdentity,
): boolean {
  return (
    isAppShotIdentity(a) &&
    isAppShotIdentity(b) &&
    a.platform === b.platform &&
    a.windowId === b.windowId &&
    a.pid === b.pid &&
    a.windowTitle === b.windowTitle &&
    (["x", "y", "width", "height"] as const).every(
      (key) => a.bounds[key] === b.bounds[key],
    )
  );
}
