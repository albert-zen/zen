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
  APP_SHOT_MAX_DEPTH,
  APP_SHOT_ACCESSIBILITY_LIMITS,
  appShotString,
  appShotImageBounds,
  type AppShotBounds,
  isAppShotImageSize,
  serializeAppShotTree,
  type AppShotAccessibilityPayload,
  type AppShotElementNode,
  type AppShotElementState,
  type AppShotImageSize,
  APP_SHOT_MAX_TEXT,
  isAppShotBounds,
  isAppShotAccessibilityIdentity,
  isRecord,
  type AppShotAccessibilityBounds,
  type AppShotAccessibilityIdentity,
} from "./app-shot-native-contract.js";

export interface AppShotAccessibilityElement {
  readonly name: string | null;
  readonly bounds: AppShotAccessibilityBounds | null;
  readonly pid?: number | null;
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly role?: string;
  readonly value?: string | null;
  readonly description?: string | null;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly checked?: "on" | "off" | "mixed" | null;
  readonly expanded?: boolean | null;
  readonly actions?: readonly string[];
  children(): Promise<readonly AppShotAccessibilityElement[]>;
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

function flatCollector() {
  const seen = new Set<string>();
  let text = "";
  let truncated = false;
  return {
    add(value: unknown) {
      // A partial fit exhausts this collector even when a surrogate leaves one slot.
      if (truncated) return;
      if (text.length >= APP_SHOT_MAX_TEXT) {
        if (value) truncated = true;
        return;
      }
      let clipped = false;
      const candidate = appShotString(value, APP_SHOT_MAX_TEXT + 1, () => {
        clipped = true;
      });
      if (!candidate || seen.has(candidate)) {
        if (clipped) truncated = true;
        return;
      }
      const separator = text ? "\n" : "";
      const remaining = APP_SHOT_MAX_TEXT - text.length - separator.length;
      const portion = appShotString(candidate, Math.max(0, remaining));
      if (portion) text += separator + portion;
      if (clipped || portion.length < candidate.length) truncated = true;
      seen.add(candidate);
    },
    result: () => ({ text, truncated }),
  };
}

/** Known native secure roles only. Provider omissions, especially UIA, are not a redaction guarantee. */
function knownSecure(
  element: AppShotAccessibilityElement,
  platform: string,
): boolean {
  if (platform !== "darwin" && platform !== "linux") return false;
  const raw = element.raw;
  if (!raw) return false;
  return (
    (platform === "darwin" &&
      (raw.ax_role === "AXSecureTextField" ||
        raw.ax_subrole === "AXSecureTextField")) ||
    (platform === "linux" &&
      (raw.atspi_role === "password text" || raw.atspi_role === "role_num:40"))
  );
}

/** Geometry failure is local: retain otherwise valid semantic descriptions. */
function elementBounds(
  element: AppShotAccessibilityElement,
): AppShotBounds | undefined {
  try {
    const value = element.bounds;
    if (!value) return undefined;
    const bounds = {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
    return isAppShotBounds(bounds) ? bounds : undefined;
  } catch {
    return undefined;
  }
}

/** Private observations, not a screen target or exported coordinate authority. */
interface AppShotCoordinateSource {
  sourceBounds: AppShotBounds;
  rootBounds: AppShotBounds;
  verifyDescendantLocations: boolean;
}

function coordinateSource(
  window: AppShotAccessibilityElement,
  identity: AppShotAccessibilityIdentity,
): AppShotCoordinateSource | undefined {
  const rootBounds = elementBounds(window);
  if (!rootBounds) return undefined;
  const wayland =
    identity.platform === "linux" && identity.matchMode === "wayland";
  if (!wayland)
    return {
      sourceBounds: rootBounds,
      rootBounds,
      verifyDescendantLocations: false,
    };
  // T3 prefers client dimensions when they match. Size-only matching still admits
  // semantic text, but neither AX coordinates alone nor a fabricated origin proves position.
  const matchingBounds =
    identity.clientBounds &&
    Math.abs(rootBounds.width - identity.clientBounds.width) <= 2 &&
    Math.abs(rootBounds.height - identity.clientBounds.height) <= 2
      ? identity.clientBounds
      : identity.bounds;
  if (
    !isAppShotBounds(matchingBounds) ||
    Math.abs(rootBounds.x - matchingBounds.x) > 2 ||
    Math.abs(rootBounds.y - matchingBounds.y) > 2
  )
    return undefined;
  // Decorated screenshots include the frame, not only the AX client area.
  const sourceBounds = identity.clientBounds ? identity.bounds : rootBounds;
  return isAppShotBounds(sourceBounds)
    ? { sourceBounds, rootBounds, verifyDescendantLocations: true }
    : undefined;
}

/** The producer already bounds this tree; downgrading coordinates preserves semantics. */
function clearDescendantBounds(root: AppShotElementNode): void {
  const pending = [...root.children];
  while (pending.length) {
    const node = pending.pop()!;
    node.bounds = null;
    pending.push(...node.children);
  }
}

/** One read-only traversal supplies both formats; no recursive native tree materialization. */
export async function appShotAccessibleElements(
  root: AppShotAccessibilityElement,
  platform: AppShotAccessibilityIdentity["platform"],
  imageSize: AppShotImageSize | undefined,
  expired: () => boolean = () => false,
  coordinates?: AppShotCoordinateSource,
): Promise<AppShotAccessibilityPayload | undefined> {
  const flat = flatCollector();
  const rich = isAppShotImageSize(imageSize);
  const stack: {
    element: AppShotAccessibilityElement;
    depth: number;
    parent?: AppShotElementNode;
  }[] = [{ element: root, depth: 0 }];
  let visited = 0;
  let traversalTruncated = false;
  let richTruncated = false;
  let richTextTruncated = false;
  let richRoot: AppShotElementNode | undefined;
  let descendantLocationVaries = false;
  // Reserve the exact envelope with truncated:false (one character longer than true).
  let richLength = rich
    ? JSON.stringify({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize,
        truncated: false,
        root: null,
      }).length - 4
    : 0;
  while (stack.length && visited < APP_SHOT_MAX_NODES) {
    if (expired()) return undefined;
    const { element, depth, parent } = stack.pop()!;
    visited++;
    if (knownSecure(element, platform)) {
      traversalTruncated = true;
      continue;
    }
    const bounds =
      rich && coordinates && depth > 0 ? elementBounds(element) : undefined;
    if (
      bounds &&
      coordinates &&
      (Math.abs(bounds.x - coordinates.rootBounds.x) > 2 ||
        Math.abs(bounds.y - coordinates.rootBounds.y) > 2)
    )
      descendantLocationVaries = true;
    const name = element.name;
    const value = element.value;
    flat.add(name);
    flat.add(value);
    let node: AppShotElementNode | undefined;
    if (rich && (depth === 0 || parent)) {
      const field = (value: unknown, limit: number, textField = false) => {
        return (
          appShotString(value, limit, () => {
            richTruncated = true;
            if (textField) richTextTruncated = true;
          }) || null
        );
      };
      const nodeName = field(name, APP_SHOT_ACCESSIBILITY_LIMITS.name, true);
      const nodeValue = field(value, APP_SHOT_ACCESSIBILITY_LIMITS.value, true);
      const description = field(
        element.description,
        APP_SHOT_ACCESSIBILITY_LIMITS.description,
      );
      const state: AppShotElementState = {};
      for (const key of [
        "active",
        "busy",
        "editable",
        "focused",
        "selected",
      ] as const)
        if (element[key] === true) state[key] = true;
      for (const key of ["enabled", "visible"] as const)
        if (element[key] === false) state[key] = false;
      const checked = element.checked;
      if (checked === "on" || checked === "off" || checked === "mixed")
        state.checked = checked;
      const expanded = element.expanded;
      if (typeof expanded === "boolean") state.expanded = expanded;
      const actions: string[] = [];
      const advertised = element.actions;
      if (advertised && !Array.isArray(advertised))
        throw new Error("Invalid accessibility actions");
      if (advertised) {
        if (advertised.length > APP_SHOT_ACCESSIBILITY_LIMITS.actions)
          richTruncated = true;
        for (
          let index = 0;
          index <
          Math.min(advertised.length, APP_SHOT_ACCESSIBILITY_LIMITS.actions);
          index++
        ) {
          const action = field(
            advertised[index],
            APP_SHOT_ACCESSIBILITY_LIMITS.action,
          );
          if (action && !actions.includes(action)) actions.push(action);
        }
      }
      node = {
        role:
          field(element.role, APP_SHOT_ACCESSIBILITY_LIMITS.role) || "unknown",
        name: nodeName,
        value: nodeValue === nodeName ? null : nodeValue,
        description:
          description === nodeName || description === nodeValue
            ? null
            : description,
        bounds:
          depth === 0
            ? { x: 0, y: 0, width: imageSize.width, height: imageSize.height }
            : bounds && coordinates
              ? appShotImageBounds(bounds, coordinates.sourceBounds, imageSize)
              : null,
        state,
        actions,
        children: [],
      };
      const extra =
        JSON.stringify(node).length + (parent?.children.length ? 1 : 0);
      if (richLength + extra > APP_SHOT_MAX_TEXT) {
        richTruncated = true;
        node = undefined;
      } else {
        richLength += extra;
        if (parent) parent.children.push(node);
        else richRoot = node;
      }
    }
    if (!node && (name || value)) richTextTruncated = true;
    if (expired()) return undefined;
    if (
      depth >= APP_SHOT_MAX_DEPTH ||
      visited + stack.length >= APP_SHOT_MAX_NODES
    ) {
      // Do not make another native child call just to discover whether this limit cut a leaf.
      traversalTruncated = true;
      continue;
    }
    const children = await element.children();
    if (expired()) return undefined;
    if (!Array.isArray(children))
      throw new Error("Invalid accessibility children");
    const capacity = APP_SHOT_MAX_NODES - visited - stack.length;
    const count = Math.min(children.length, capacity);
    if (count < children.length) traversalTruncated = true;
    for (let index = count - 1; index >= 0; index--)
      stack.push({
        element: children[index]!,
        depth: depth + 1,
        ...(node ? { parent: node } : {}),
      });
  }
  const fallback = flat.result();
  const truncated = traversalTruncated || stack.length > 0;
  if (
    richRoot &&
    coordinates?.verifyDescendantLocations &&
    !descendantLocationVaries
  )
    clearDescendantBounds(richRoot);
  if (richRoot && !(richTextTruncated && fallback.text)) {
    const payload: AppShotAccessibilityPayload = {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: imageSize!,
      truncated: truncated || richTruncated,
      root: richRoot,
    };
    if (serializeAppShotTree(payload)) return payload;
  }
  return fallback.text
    ? {
        format: "flat-text",
        text: fallback.text,
        truncated: truncated || fallback.truncated,
      }
    : undefined;
}

export async function readAppShotAccessibilityWithApi(
  App: AppShotAccessibilityApi,
  identity: AppShotAccessibilityIdentity,
  isAppNotFoundError: (error: unknown) => boolean = () => false,
  imageSize?: AppShotImageSize,
): Promise<AppShotAccessibilityPayload | undefined> {
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
    const coordinates = coordinateSource(window, identity);
    const result = await appShotAccessibleElements(
      window,
      identity.platform,
      imageSize,
      () => expired,
      coordinates,
    );
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
      if (
        coordinates &&
        result?.format === "element-tree" &&
        !coordinateSource(currentMatches[0]!, identity)
      )
        clearDescendantBounds(result.root);
    }
    return result;
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
