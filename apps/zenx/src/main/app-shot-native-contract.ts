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
export const APP_SHOT_MAX_DEPTH = 64;
export const APP_SHOT_ACCESSIBILITY_LIMITS = {
  role: 100,
  name: 1000,
  value: 8000,
  description: 2000,
  action: 100,
  actions: 32,
} as const;
export const APP_SHOT_MAX_PNG_BYTES = 20 * 1024 * 1024;
export const APP_SHOT_MAX_PIXELS = 64 * 1024 * 1024;

export interface AppShotText {
  text: string;
  truncated: boolean;
  /** Semantic JSON remains data within the existing untrusted attachment context. */
  format?: "flat-text" | "element-tree";
}

export interface AppShotElementState {
  active?: true;
  busy?: true;
  editable?: true;
  focused?: true;
  selected?: true;
  enabled?: false;
  visible?: false;
  checked?: "on" | "off" | "mixed";
  expanded?: boolean;
}

export interface AppShotElementNode {
  role: string;
  name: string | null;
  value: string | null;
  description: string | null;
  /** Descriptive captured-image pixels only, never a native position or input target. */
  bounds: AppShotBounds | null;
  state: AppShotElementState;
  /** Advertised names only, never executable actions or target references. */
  actions: string[];
  children: AppShotElementNode[];
}

export type AppShotAccessibilityPayload =
  | { format: "flat-text"; text: string; truncated: boolean }
  | {
      format: "element-tree";
      coordinateSpace: "captured-image";
      imageSize: AppShotImageSize;
      truncated: boolean;
      root: AppShotElementNode;
    };

export interface AppShotImageSize {
  width: number;
  height: number;
}

export function isAppShotImageSize(value: unknown): value is AppShotImageSize {
  return (
    isDataRecord(value) &&
    exactKeys(value, ["width", "height"]) &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0 &&
    Number(value.width) * Number(value.height) <= APP_SHOT_MAX_PIXELS
  );
}

/** Scalar sanitation cannot bound the native call that materialized the string. */
export function appShotString(
  value: unknown,
  max: number,
  onTruncated?: () => void,
): string {
  if (typeof value !== "string") return "";
  const clean = value.replaceAll("\0", "").trim();
  if (clean.length > max) onTruncated?.();
  let end = Math.min(max, clean.length);
  if (end < clean.length && /[\uD800-\uDBFF]/u.test(clean[end - 1] ?? ""))
    end--;
  // Drop unpaired surrogates from malformed provider strings, not just cut pairs.
  return clean
    .slice(0, end)
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
      "",
    )
    .trim();
}

/** Iterative serialization, bounded before allocation of an oversized result. */
export function serializeAppShotTree(
  payload: Extract<AppShotAccessibilityPayload, { format: "element-tree" }>,
): string | undefined {
  const parts: string[] = [];
  const stack: (AppShotElementNode | string)[] = ["}", payload.root];
  let text = `{"format":"element-tree","coordinateSpace":"captured-image","imageSize":${JSON.stringify(payload.imageSize)},"truncated":${payload.truncated},"root":`;
  let length = text.length;
  parts.push(text);
  while (stack.length) {
    const next = stack.pop()!;
    if (typeof next === "string") text = next;
    else {
      const { children, ...fields } = next;
      text = JSON.stringify(fields).slice(0, -1) + ',"children":[';
      stack.push("]}");
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push(children[index]!);
        if (index > 0) stack.push(",");
      }
    }
    length += text.length;
    if (length > APP_SHOT_MAX_TEXT) return undefined;
    parts.push(text);
  }
  return parts.join("");
}

/** IPC is data only: reject accessors and custom serialization hooks in injected values too. */
function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}

function isDataArray(value: unknown, max: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) =>
      Object.getOwnPropertyDescriptor(value, index),
    ).every(
      (descriptor) => descriptor?.enumerable === true && "value" in descriptor,
    )
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function validScalar(value: unknown, max: number, nullable = false): boolean {
  return (
    (nullable && value === null) ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      appShotString(value, max) === value)
  );
}

/** Exact image rectangles have no native metadata, fractional edges or off-image area. */
function isAppShotImageBounds(
  value: unknown,
  size: AppShotImageSize,
): value is AppShotBounds {
  return (
    isDataRecord(value) &&
    exactKeys(value, ["x", "y", "width", "height"]) &&
    ["x", "y", "width", "height"].every((key) =>
      Number.isSafeInteger(value[key]),
    ) &&
    Number(value.x) >= 0 &&
    Number(value.y) >= 0 &&
    Number(value.width) > 0 &&
    Number(value.height) > 0 &&
    Number(value.x) + Number(value.width) <= size.width &&
    Number(value.y) + Number(value.height) <= size.height
  );
}

/** T3 edge rounding and image clipping; callers admit safe source/element geometry first. */
export function appShotImageBounds(
  bounds: AppShotBounds,
  source: AppShotBounds,
  size: AppShotImageSize,
): AppShotBounds | null {
  const sx = size.width / source.width;
  const sy = size.height / source.height;
  const x = Math.max(0, Math.round((bounds.x - source.x) * sx));
  const y = Math.max(0, Math.round((bounds.y - source.y) * sy));
  const right = Math.min(
    size.width,
    Math.round((bounds.x + bounds.width - source.x) * sx),
  );
  const bottom = Math.min(
    size.height,
    Math.round((bounds.y + bounds.height - source.y) * sy),
  );
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

/** Windows pixels may be resized after AX. Validate, scale every node, then rebudget. */
export function resizeAppShotAccessibility(
  read: AppShotText,
  size: AppShotImageSize,
): AppShotText | undefined {
  if (read.format !== "element-tree") return read;
  try {
    if (read.text.length > APP_SHOT_MAX_TEXT || !isAppShotImageSize(size))
      return undefined;
    const value: unknown = JSON.parse(read.text);
    if (
      !isRecord(value) ||
      !isAppShotImageSize(value.imageSize) ||
      !parseAppShotAccessibility(value, value.imageSize)
    )
      return undefined;
    // Validation bounds the tree before this iterative walk and rejects all hooks/cycles.
    const payload = value as unknown as Extract<
      AppShotAccessibilityPayload,
      { format: "element-tree" }
    >;
    const source = { x: 0, y: 0, ...payload.imageSize };
    const pending = [payload.root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.bounds)
        node.bounds = appShotImageBounds(node.bounds, source, size);
      pending.push(...node.children);
    }
    payload.imageSize = size;
    return parseAppShotAccessibility(payload, size);
  } catch {
    return undefined;
  }
}

/** Total parent-side validation: rejects extra fields, cycles, depth and output excess. */
export function parseAppShotAccessibility(
  value: unknown,
  imageSize?: AppShotImageSize,
): AppShotText | undefined {
  try {
    if (!isDataRecord(value) || typeof value.truncated !== "boolean")
      return undefined;
    if (value.format === "flat-text") {
      if (
        !exactKeys(value, ["format", "text", "truncated"]) ||
        !validScalar(value.text, APP_SHOT_MAX_TEXT)
      )
        return undefined;
      return {
        text: value.text as string,
        truncated: value.truncated,
        format: "flat-text",
      };
    }
    if (
      value.format !== "element-tree" ||
      !exactKeys(value, [
        "format",
        "coordinateSpace",
        "imageSize",
        "truncated",
        "root",
      ]) ||
      value.coordinateSpace !== "captured-image" ||
      !isAppShotImageSize(value.imageSize) ||
      !isAppShotImageSize(imageSize) ||
      value.imageSize.width !== imageSize.width ||
      value.imageSize.height !== imageSize.height
    )
      return undefined;
    const pending = [{ node: value.root, depth: 0 }];
    const seen = new Set<unknown>();
    let count = 0;
    let scalarSize = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (
        !isDataRecord(node) ||
        seen.has(node) ||
        depth > APP_SHOT_MAX_DEPTH ||
        ++count > APP_SHOT_MAX_NODES ||
        !exactKeys(node, [
          "role",
          "name",
          "value",
          "description",
          "bounds",
          "state",
          "actions",
          "children",
        ]) ||
        (depth === 0
          ? !isAppShotImageBounds(node.bounds, imageSize) ||
            node.bounds.x !== 0 ||
            node.bounds.y !== 0 ||
            node.bounds.width !== imageSize.width ||
            node.bounds.height !== imageSize.height
          : node.bounds !== null &&
            !isAppShotImageBounds(node.bounds, imageSize))
      )
        return undefined;
      seen.add(node);
      for (const key of ["role", "name", "value", "description"] as const) {
        if (
          !validScalar(
            node[key],
            APP_SHOT_ACCESSIBILITY_LIMITS[key],
            key !== "role",
          )
        )
          return undefined;
        scalarSize += typeof node[key] === "string" ? node[key].length : 0;
      }
      if (scalarSize > APP_SHOT_MAX_TEXT || !isDataRecord(node.state))
        return undefined;
      const states = Object.entries(node.state);
      if (states.length > 9) return undefined;
      for (const [key, state] of states) {
        if (
          ["active", "busy", "editable", "focused", "selected"].includes(key)
        ) {
          if (state !== true) return undefined;
        } else if (key === "enabled" || key === "visible") {
          if (state !== false) return undefined;
        } else if (key === "checked") {
          if (!["on", "off", "mixed"].includes(state as string))
            return undefined;
        } else if (key !== "expanded" || typeof state !== "boolean")
          return undefined;
      }
      if (
        !isDataArray(node.actions, APP_SHOT_ACCESSIBILITY_LIMITS.actions) ||
        node.actions.some(
          (action) =>
            !validScalar(action, APP_SHOT_ACCESSIBILITY_LIMITS.action),
        ) ||
        new Set(node.actions).size !== node.actions.length ||
        !isDataArray(node.children, APP_SHOT_MAX_NODES) ||
        node.children.length > APP_SHOT_MAX_NODES - count - pending.length
      )
        return undefined;
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push({ node: node.children[index], depth: depth + 1 });
    }
    const text = serializeAppShotTree(
      value as unknown as Extract<
        AppShotAccessibilityPayload,
        { format: "element-tree" }
      >,
    );
    return text
      ? { text, truncated: value.truncated, format: "element-tree" }
      : undefined;
  } catch {
    return undefined;
  }
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
