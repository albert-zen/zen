import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppShotActiveWindow } from "./app-shot-native.js";
import {
  APP_SHOT_MAX_TEXT,
  type AppShotWindowsCapture,
} from "./app-shot-native-capture.js";

/** A host-owned selection token, not an OS window handle or computer-control target. */
export interface AppShotSource {
  id: string;
  title: string;
  applicationName?: string;
}

/** Prepared for a Composer draft. Capture never sends a turn or invokes input. */
export interface AppShotCapture {
  name: string;
  bytes: Uint8Array;
  mediaType: "image/png";
  context: string;
}

export interface AppShotNativeImage {
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

export interface AppShotNativeSource {
  id: string;
  title: string;
  image?: AppShotNativeImage;
}

export interface AppShotAccessibilityRead {
  windowId: number;
  windowTitle: string;
  pid: number;
  applicationName?: string;
  text: string;
}

export interface AppShotService {
  listSources(): Promise<AppShotSource[]>;
  capture(
    sourceId: string,
    options?: { includeAccessibility?: boolean; signal?: AbortSignal },
  ): Promise<AppShotCapture>;
  captureActive(options?: {
    includeAccessibility?: boolean;
    signal?: AbortSignal;
  }): Promise<AppShotCapture>;
}

export interface AppShotDependencies {
  /** Must enumerate only windows. A zero size avoids preview capture during listing. */
  getWindowSources(size: {
    width: number;
    height: number;
  }): Promise<readonly AppShotNativeSource[]>;
  excludedSourceIds?: () => readonly string[];
  readAccessibility?: (request: {
    windowId: number;
    windowTitle: string;
    expectedIdentity?: AppShotActiveWindow;
    signal?: AbortSignal;
  }) => Promise<AppShotAccessibilityRead | undefined>;
  captureActiveNative?: (options?: { includeAccessibility?: boolean; signal?: AbortSignal }) => Promise<AppShotCapture>;
  getActiveWindow?: () => Promise<AppShotActiveWindow>;
  getWindowMetadata?: (windowId: number) => Promise<AppShotActiveWindow>;
}

const CAPTURE_SIZE = { width: 1600, height: 1000 };
const LIST_SIZE = { width: 0, height: 0 };
const MAX_AX_TEXT = APP_SHOT_MAX_TEXT;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type Selection = { nativeId: string; title: string; windowId: number };

function windowIdOf(sourceId: string): number | undefined {
  const match = /^window:([1-9]\d*):\d+$/u.exec(sourceId);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

function plain(value: string, max: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function filename(title: string): string {
  const stem = plain(title, 80)
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/^\.+/u, "")
    .trim();
  return `${stem || "window"}.png`;
}

function excluded(sourceId: string, ownIds: readonly string[]): boolean {
  const id = windowIdOf(sourceId);
  return ownIds.some(
    (own) => own === sourceId || (id !== undefined && windowIdOf(own) === id),
  );
}

export function createAppShotService(
  dependencies: AppShotDependencies,
): AppShotService {
  let selections = new Map<string, Selection>();
  return {
    async listSources() {
      // Invalidates all prior tokens, including on enumeration failure.
      selections = new Map();
      const sources = await dependencies.getWindowSources(LIST_SIZE);
      const ownIds = dependencies.excludedSourceIds?.() ?? [];
      const counts = new Map<string, number>();
      for (const source of sources)
        counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
      const listed: AppShotSource[] = [];
      for (const source of sources) {
        const windowId = windowIdOf(source.id);
        const title = plain(source.title, 200);
        if (
          windowId === undefined ||
          !title ||
          excluded(source.id, ownIds) ||
          counts.get(source.id) !== 1
        )
          continue;
        const id = randomUUID();
        selections.set(id, {
          nativeId: source.id,
          title: source.title,
          windowId,
        });
        listed.push({ id, title });
      }
      return listed;
    },
    async captureActive(options) {
      if (options?.signal?.aborted) throw new Error("App Shot cancelled");
      if (dependencies.captureActiveNative)
        return dependencies.captureActiveNative(options);
      if (!dependencies.getActiveWindow)
        throw new Error(
          "Active-window App Shot is unavailable on this platform; choose a window instead",
        );
      // Read the target before enumeration or any UI activation. A title alone is never enough.
      const active = await dependencies.getActiveWindow();
      if (
        !Number.isSafeInteger(active.windowId) ||
        active.windowId <= 0 ||
        !Number.isSafeInteger(active.pid) ||
        active.pid <= 0 ||
        active.pid === process.pid ||
        !active.windowTitle
      )
        throw new Error(
          "Active window identity is unavailable; choose a window instead",
        );
      await this.listSources();
      const matches = Array.from(selections, ([token, value]) => ({
        token,
        value,
      })).filter(
        ({ value }) =>
          value.windowId === active.windowId &&
          value.title === active.windowTitle,
      );
      if (matches.length !== 1)
        throw new Error(
          "Active window is unavailable or ambiguous; choose a window instead",
        );
      const shot = await this.capture(matches[0]!.token, options);
      const after = await dependencies.getActiveWindow();
      if (
!sameObservedWindow(active, after)
      )
        throw new Error(
          "Active window changed during App Shot; choose a window instead",
        );
      return active.applicationName
        ? {
            ...shot,
            context: `${shot.context}\nApplication: ${plain(active.applicationName, 100)} (foreground process at capture start).`,
          }
        : shot;
    },
    async capture(sourceId, options) {
      if (options?.signal?.aborted) throw new Error("App Shot cancelled");
      const selected = selections.get(sourceId);
      if (selected === undefined)
        throw new Error(
          "App Shot selection is missing or stale; choose the window again",
        );
      if (excluded(selected.nativeId, dependencies.excludedSourceIds?.() ?? []))
        throw new Error("App Shot cannot capture its own window");
      const capturedAt = new Date().toISOString();
      let expectedIdentity: AppShotActiveWindow | undefined;
      if (dependencies.getWindowMetadata) {
        try {
          const before = await dependencies.getWindowMetadata(selected.windowId);
          if (before.windowId === selected.windowId && before.windowTitle === selected.title && before.pid > 0)
            expectedIdentity = before;
        } catch { /* Metadata is optional for an explicit screenshot. */ }
      }
      const sources = await dependencies.getWindowSources(CAPTURE_SIZE);
      const matches = sources.filter(
        (candidate) => candidate.id === selected.nativeId,
      );
      if (matches.length === 0)
        throw new Error("Selected window is no longer available");
      if (matches.length > 1)
        throw new Error("Selected window identity is ambiguous");
      const source = matches[0]!;
      if (source.title !== selected.title)
        throw new Error("Selected window title changed; choose it again");
      if (!source.image || source.image.isEmpty())
        throw new Error(
          "Selected window capture is empty; check Screen Recording permission and try again",
        );
      const bytes = source.image.toPNG();
      if (!bytes.byteLength)
        throw new Error("Selected window capture is empty");
      if (bytes.byteLength > MAX_IMAGE_BYTES)
        throw new Error("Selected window capture exceeds the image size limit");
      let applicationName: string | undefined;
      if (expectedIdentity && dependencies.getWindowMetadata &&
          !sameObservedWindow(expectedIdentity, await dependencies.getWindowMetadata(selected.windowId)))
        throw new Error("Selected window changed during App Shot");
      if (dependencies.getWindowMetadata) {
        try {
          const metadata = await dependencies.getWindowMetadata(
            selected.windowId,
          );
          if (
            metadata.windowId === selected.windowId &&
            metadata.windowTitle === selected.title &&
            Number.isSafeInteger(metadata.pid) &&
            metadata.pid > 0
          )
            applicationName = metadata.applicationName
              ? plain(metadata.applicationName, 100)
              : undefined;
        } catch {
          // CG metadata is optional; it never retargets the selected screenshot.
        }
      }
      let accessibilityText: string | undefined;
      if (options?.includeAccessibility && dependencies.readAccessibility) {
        try {
          const read = await dependencies.readAccessibility({
            windowId: selected.windowId,
            windowTitle: selected.title,
            expectedIdentity,
            signal: options.signal,
          });
          if (
            read?.windowId === selected.windowId &&
            read.windowTitle === selected.title &&
            Number.isSafeInteger(read.pid) &&
            read.pid > 0
          ) {
            applicationName = read.applicationName
              ? plain(read.applicationName, 100)
              : undefined;
            accessibilityText = read.text.replaceAll("\0", "").slice(0, MAX_AX_TEXT);
            if (/[\uD800-\uDBFF]/u.test(accessibilityText.at(-1) ?? ""))
              accessibilityText = accessibilityText.slice(0, -1);
          }
        } catch {
          // An AX failure cannot change the screenshot target or leak another app's text.
        }
      }
      if (options?.signal?.aborted) throw new Error("App Shot cancelled");
      const context = [
        `App Shot of external window "${plain(selected.title, 1000)}"${applicationName ? ` in ${applicationName}` : ""}.`,
        `Captured at: ${capturedAt}.`,
        accessibilityText
          ? `Accessibility text from this same window (read-only, truncated to ${MAX_AX_TEXT} characters): ${accessibilityText}`
          : options?.includeAccessibility
            ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
            : "Screenshot only. Accessibility text was not requested.",
        "This is a draft attachment, not permission to control the app.",
      ].join("\n");
      return {
        name: filename(selected.title),
        bytes,
        mediaType: "image/png",
        context,
      };
    },
  };
}

/** Electron adapter: never requests screen sources or keeps unselected thumbnails. */
export function createElectronAppShotService(
  options: {
    excludedSourceIds?: () => readonly string[];
  } = {},
): AppShotService {
  return createAppShotService({
    excludedSourceIds: options.excludedSourceIds,
    getWindowSources: async (thumbnailSize) => {
      const { desktopCapturer } = await import("electron");
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize,
        fetchWindowIcons: false,
      });
      return sources.map((source) => ({
        id: source.id,
        title: source.name,
        image: thumbnailSize.width ? source.thumbnail : undefined,
      }));
    },
    captureActiveNative: process.platform === "win32" ? async (captureOptions) => {
      const { app, nativeImage } = await import("electron");
      const { captureWindowsActiveAppShot } = await import("./app-shot-native-capture.js");
      const shot = await captureWindowsActiveAppShot({
        workerPath: join(app.getAppPath(), "out/main/app-shot-native-worker.js"),
        includeAccessibility: captureOptions?.includeAccessibility,
        signal: captureOptions?.signal,
        excludedWindowIds: (options.excludedSourceIds?.() ?? [])
          .map(windowIdOf).filter((id): id is number => id !== undefined),
      });
      const image = nativeImage.createFromBuffer(shot.png);
      if (image.isEmpty()) throw new Error("App Shot returned an empty image");
      const dimensions = fitAppShotDimensions(image.getSize());
      const resized = image.resize({ ...dimensions, quality: "best" });
      const png = resized.toPNG();
      if (!png.length || png.length > MAX_IMAGE_BYTES)
        throw new Error("App Shot image exceeds the byte budget");
      return windowsAppShotDraft({ ...shot, png, ...resized.getSize() }, captureOptions?.includeAccessibility === true);
    } : undefined,
    readAccessibility:
      process.platform === "darwin" ? readMacAppShotAccessibility : undefined,
    getActiveWindow:
      process.platform === "darwin"
        ? async () =>
            (await import("./app-shot-native.js")).readMacActiveWindow()
        : undefined,
    getWindowMetadata:
      process.platform === "darwin"
        ? async (windowId) =>
            (await import("./app-shot-native.js")).readMacWindowMetadata(
              windowId,
            )
        : undefined,
  });
}

/** Match a host observation, including geometry when the native backend supplies it. */
export function sameObservedWindow(a: AppShotActiveWindow, b: AppShotActiveWindow): boolean {
  return a.windowId === b.windowId && a.pid === b.pid && a.windowTitle === b.windowTitle &&
    (a.bounds === undefined ? b.bounds === undefined : b.bounds !== undefined &&
      (["x", "y", "width", "height"] as const).every((key) => a.bounds![key] === b.bounds![key]));
}

export function windowsAppShotDraft(shot: AppShotWindowsCapture, includeAccessibility: boolean): AppShotCapture {
  const text = includeAccessibility ? shot.accessibility?.text : undefined;
  return {
    name: filename(shot.identity.windowTitle),
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      `App Shot of external window "${plain(shot.identity.windowTitle, 1000)}"${shot.identity.applicationName ? ` in ${plain(shot.identity.applicationName, 100)}` : ""}.`,
      `Captured at: ${new Date().toISOString()}.`,
      "Capture: visible desktop region at the foreground window bounds. Overlapping windows may appear in these pixels.",
      text
        ? `Accessibility text from this same window (read-only${shot.accessibility?.truncated ? ", truncated" : ""}): ${text}`
        : includeAccessibility
          ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
          : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}

/** T3's bounded name/value extraction in a disposable worker; never grants AX access. */
async function readMacAppShotAccessibility(request: {
  windowId: number;
  windowTitle: string;
  expectedIdentity?: AppShotActiveWindow;
  signal?: AbortSignal;
}): Promise<AppShotAccessibilityRead | undefined> {
  const expected = request.expectedIdentity;
  if (!expected?.bounds) return undefined;
  const { readMacWindowMetadata } = await import("./app-shot-native.js");
  const metadata = await readMacWindowMetadata(request.windowId);
  if (!sameObservedWindow(expected, metadata)) return undefined;
  const { app } = await import("electron");
  const { readCapturedAppShotAccessibility } = await import("./app-shot-native-capture.js");
  const read = await readCapturedAppShotAccessibility(
    { ...expected, platform: "darwin", bounds: expected.bounds },
    { workerPath: join(app.getAppPath(), "out/main/app-shot-native-worker.js"), signal: request.signal },
  );
  if (!read || !sameObservedWindow(expected, await readMacWindowMetadata(request.windowId)))
    return undefined;
  return { ...expected, text: read.text };
}

/** T3's bounded image envelope, preserving aspect ratio without upscaling. */
export function fitAppShotDimensions(size: { width: number; height: number }): { width: number; height: number } {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0)
    throw new Error("App Shot image dimensions are invalid");
  const scale = Math.min(1, 2560 / size.width, 1600 / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}
