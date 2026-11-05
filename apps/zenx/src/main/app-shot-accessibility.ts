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

import {
  APP_SHOT_MAX_NODES,
  APP_SHOT_MAX_TEXT,
  isAppShotBounds,
  isAppShotIdentity,
  type AppShotBounds,
  type AppShotCaptureIdentity,
  type AppShotText,
} from "./app-shot-native-contract.js";

export interface AppShotAccessibilityTree {
  name?: string;
  value?: string;
  children: readonly AppShotAccessibilityTree[];
}

export interface AppShotAccessibilityElement {
  readonly name: string | null;
  readonly bounds: AppShotBounds | null;
  tree(): Promise<AppShotAccessibilityTree>;
}

interface AppShotAccessibilityApplication {
  readonly pid: number | null;
  children(): Promise<readonly AppShotAccessibilityElement[]>;
  asElement(): AppShotAccessibilityElement;
}

/** Deliberately omits all input, action, selector and permission APIs. */
export interface AppShotAccessibilityApi {
  foreground(options: {
    timeout: number;
  }): Promise<AppShotAccessibilityApplication | undefined>;
  byPid(
    pid: number,
    options: { timeout: number },
  ): Promise<AppShotAccessibilityApplication>;
}

function matchesWindow(
  window: AppShotAccessibilityElement,
  identity: AppShotCaptureIdentity,
): boolean {
  try {
    const bounds = window.bounds;
    return (
      window.name?.trim() === identity.windowTitle.trim() &&
      isAppShotBounds(bounds) &&
      (["x", "y", "width", "height"] as const).every(
        (key) => Math.abs(bounds[key] - identity.bounds[key]) <= 2,
      )
    );
  } catch {
    return false;
  }
}

/** T3's name/value extraction, with explicit truncation and bounded stack growth. */
export function appShotAccessibleText(
  root: AppShotAccessibilityTree,
): AppShotText {
  const seen = new Set<string>();
  const stack = [root];
  let text = "";
  let visited = 0;
  let truncated = false;
  while (
    stack.length > 0 &&
    text.length < APP_SHOT_MAX_TEXT &&
    visited < APP_SHOT_MAX_NODES
  ) {
    const node = stack.pop()!;
    visited += 1;
    for (const value of [node.name, node.value]) {
      const candidate =
        typeof value === "string" ? value.replaceAll("\0", "").trim() : "";
      if (!candidate || seen.has(candidate)) continue;
      const separator = text ? "\n" : "";
      const remaining = APP_SHOT_MAX_TEXT - text.length - separator.length;
      if (remaining <= 0) return { text, truncated: true };
      const end =
        candidate.length <= remaining
          ? candidate.length
          : /[\uD800-\uDBFF]/u.test(candidate[remaining - 1] ?? "")
            ? remaining - 1
            : remaining;
      if (end === 0) return { text, truncated: true };
      text += separator + candidate.slice(0, end);
      if (end < candidate.length) return { text, truncated: true };
      seen.add(candidate);
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const capacity = APP_SHOT_MAX_NODES - visited - stack.length;
    const count = Math.min(children.length, capacity);
    if (count < children.length) truncated = true;
    for (let index = count - 1; index >= 0; index--)
      stack.push(children[index]!);
  }
  return { text, truncated: truncated || stack.length > 0 };
}

export async function readAppShotAccessibilityWithApi(
  App: AppShotAccessibilityApi,
  identity: AppShotCaptureIdentity,
): Promise<AppShotText | undefined> {
  if (!isAppShotIdentity(identity)) return undefined;
  // Windows UIA's foreground root is the window. macOS AX is PID-scoped.
  // Unlike T3's Linux fallback, never enumerate other applications.
  const app =
    identity.platform === "win32"
      ? await App.foreground({ timeout: 0 })
      : await App.byPid(identity.pid, { timeout: 0 });
  if (!app || app.pid !== identity.pid) return undefined;
  const windows =
    identity.platform === "win32" ? [app.asElement()] : await app.children();
  const matches = windows.filter((window) => matchesWindow(window, identity));
  if (matches.length !== 1) return undefined;
  const window = matches[0]!;
  const tree = await window.tree();
  if (app.pid !== identity.pid || !matchesWindow(window, identity))
    return undefined;
  const result = appShotAccessibleText(tree);
  return result.text ? result : undefined;
}
