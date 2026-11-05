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
  isAppShotAccessibilityIdentity,
  isRecord,
  type AppShotAccessibilityBounds,
  type AppShotAccessibilityIdentity,
  type AppShotText,
} from "./app-shot-native-contract.js";

export interface AppShotAccessibilityTree {
  name?: string;
  value?: string;
  children: readonly AppShotAccessibilityTree[];
}

export interface AppShotAccessibilityElement {
  readonly name: string | null;
  readonly bounds: AppShotAccessibilityBounds | null;
  readonly pid?: number | null;
  readonly raw?: Readonly<Record<string, unknown>>;
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
  ): Promise<AppShotAccessibilityApplication | undefined>;
  list?(): Promise<readonly AppShotAccessibilityApplication[]>;
}

const ACCESSIBILITY_TIMEOUT_MS = 3_000;
export const APP_SHOT_MAX_ACCESSIBILITY_APPS = 64;
export const APP_SHOT_MAX_ACCESSIBILITY_WINDOWS = 256;

function linuxWindowKey(window: AppShotAccessibilityElement) {
  const raw = window.raw;
  if (
    !isRecord(raw) ||
    raw.atspi_defunct === true ||
    typeof raw.bus_name !== "string" ||
    !raw.bus_name.startsWith(":") ||
    raw.bus_name.length > 255 ||
    typeof raw.object_path !== "string" ||
    !raw.object_path.startsWith("/") ||
    raw.object_path.length > 4096 ||
    !Number.isSafeInteger(window.pid) ||
    Number(window.pid) <= 0
  )
    return undefined;
  // Linux numeric handles are minted per snapshot. Object path alone is not
  // unique across apps; use its AT-SPI unique bus owner as well, never export it.
  return { bus: raw.bus_name, path: raw.object_path, pid: window.pid };
}

function matchesWindow(
  window: AppShotAccessibilityElement,
  identity: AppShotAccessibilityIdentity,
  untitledOnly = false,
): boolean {
  const wayland =
    identity.platform === "linux" && identity.matchMode === "wayland";
  const normalizeTitle = (title: string) =>
    wayland
      ? title.trim().replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s+|$)/u, "")
      : title.trim();
  const title = normalizeTitle(identity.windowTitle);
  const windowTitle = normalizeTitle(window.name ?? "");
  if (!title || (untitledOnly ? windowTitle !== "" : windowTitle !== title))
    return false;
  const bounds = window.bounds;
  if (!bounds) return false;
  const candidates =
    wayland && identity.clientBounds
      ? [identity.bounds, identity.clientBounds]
      : [identity.bounds];
  if (wayland) {
    // AT-SPI may omit position or return a sentinel for it. Never invent a screen origin.
    return candidates.some((candidate) =>
      (["width", "height"] as const).every(
        (key) =>
          Number.isFinite(bounds[key]) &&
          bounds[key] > 0 &&
          Math.abs(bounds[key] - candidate[key]) <= 2,
      ),
    );
  }
  return (
    isAppShotBounds(bounds) &&
    isAppShotBounds(identity.bounds) &&
    (["x", "y", "width", "height"] as const).every(
      (key) => Math.abs(bounds[key] - identity.bounds[key]!) <= 2,
    )
  );
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
  identity: AppShotAccessibilityIdentity,
  isAppNotFoundError: (error: unknown) => boolean = () => false,
): Promise<AppShotText | undefined> {
  if (!isAppShotAccessibilityIdentity(identity)) return undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    // Windows UIA's foreground root is the window; macOS AX and Linux AT-SPI are PID-scoped.
    const app = await (
      identity.platform === "win32"
        ? App.foreground({ timeout: 0 })
        : App.byPid(identity.pid, { timeout: 0 })
    ).catch((error: unknown) => {
      // Only xa11y's typed single-attempt app miss permits Linux proxy lookup.
      // Permission, disabled-accessibility, transport and unknown errors do not.
      if (identity.platform === "linux" && isAppNotFoundError(error))
        return undefined;
      throw error;
    });
    if (expired || (app && app.pid !== identity.pid)) return undefined;
    const pidWindows = app
      ? identity.platform === "win32"
        ? [app.asElement()]
        : await app.children()
      : [];
    if (expired || pidWindows.length > APP_SHOT_MAX_ACCESSIBILITY_WINDOWS)
      return undefined;
    let windows = [...pidWindows];
    let owners: { app: AppShotAccessibilityApplication; pid: number | null }[] =
      windows.map(() => ({ app: app!, pid: identity.pid }));
    if (windows.length === 0 && identity.platform === "linux") {
      // Flatpak's compositor PID can miss its AT-SPI proxy. Enumerate only bounded
      // top-level metadata, and only after an empty PID lookup. A partial list
      // cannot prove uniqueness, so any failed/oversized enumeration fails closed.
      if (!App.list) return undefined;
      const apps = await App.list();
      if (expired || apps.length > APP_SHOT_MAX_ACCESSIBILITY_APPS)
        return undefined;
      windows = [];
      owners = [];
      for (const candidate of apps) {
        const pid = candidate.pid;
        const children = await candidate.children();
        if (
          expired ||
          candidate.pid !== pid ||
          children.length > APP_SHOT_MAX_ACCESSIBILITY_WINDOWS - windows.length
        )
          return undefined;
        windows.push(...children);
        owners.push(...children.map(() => ({ app: candidate, pid })));
      }
    }
    let untitledOnly = false;
    let matches = windows.flatMap((window, index) =>
      matchesWindow(window, identity)
        ? [{ window, owner: owners[index]! }]
        : [],
    );
    if (
      matches.length === 0 &&
      identity.platform === "linux" &&
      pidWindows.length > 0
    ) {
      // T3's GTK4 fallback: unnamed frames may match only within the verified
      // positive PID, never an App.list result. Named matches take precedence.
      untitledOnly = true;
      matches = windows.flatMap((window, index) =>
        matchesWindow(window, identity, true)
          ? [{ window, owner: owners[index]! }]
          : [],
      );
    }
    // No active-window tie break: equal titles/sizes must not read an arbitrary tree.
    if (expired || matches.length !== 1) return undefined;
    const { window, owner } = matches[0]!;
    if (owner.app.pid !== owner.pid) return undefined;
    const linuxKey =
      identity.platform === "linux" ? linuxWindowKey(window) : undefined;
    if (
      identity.platform === "linux" &&
      (!linuxKey || linuxKey.pid !== owner.pid)
    )
      return undefined;
    const tree = await window.tree();
    if (
      expired ||
      owner.app.pid !== owner.pid ||
      (identity.platform !== "linux" && !matchesWindow(window, identity))
    )
      return undefined;
    if (linuxKey) {
      // Element getters are snapshots. Re-query only this retained application's
      // top-level metadata after the tree read; do not re-enumerate other apps or
      // take new pixels. This is fresh AX validation, not atomic pixel/text capture.
      const currentWindows = await owner.app.children();
      if (
        expired ||
        currentWindows.length > APP_SHOT_MAX_ACCESSIBILITY_WINDOWS ||
        owner.app.pid !== owner.pid
      )
        return undefined;
      if (
        untitledOnly &&
        currentWindows.some((current) => matchesWindow(current, identity))
      )
        return undefined;
      const currentMatches = currentWindows.filter((current) =>
        matchesWindow(current, identity, untitledOnly),
      );
      if (currentMatches.length !== 1) return undefined;
      const currentKey = linuxWindowKey(currentMatches[0]!);
      if (
        !currentKey ||
        currentKey.bus !== linuxKey.bus ||
        currentKey.path !== linuxKey.path ||
        currentKey.pid !== linuxKey.pid
      )
        return undefined;
    }
    const result = appShotAccessibleText(tree);
    return result.text ? result : undefined;
  };
  try {
    return await Promise.race([
      read().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(undefined);
        }, ACCESSIBILITY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
