import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { niriSocketPath, type NiriAppShotCapture } from "./app-shot-niri.js";
import type {
  GnomeAppShotCapture,
  GnomeAppShotSupport,
} from "./app-shot-gnome.js";
import type { KdeAppShotCapture, KdeAppShotSupport } from "./app-shot-kde.js";
import type {
  HyprlandAppShotCapture,
  HyprlandAppShotState,
} from "./app-shot-hyprland.js";
import type { PortalAppShotCapture } from "./app-shot-portal.js";
import {
  isAppShotImageSize,
  isRecord,
  parseAppShotAccessibility,
  type AppShotImageSize,
  type AppShotLinuxCaptureIdentity,
  type AppShotText,
} from "./app-shot-native-contract.js";
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
  format?: AppShotText["format"];
  truncated?: boolean;
}

export interface AppShotService {
  readonly hasNativeActiveCapture?: boolean;
  listSources(): Promise<AppShotSource[]>;
  capture(
    sourceId: string,
    options?: { includeAccessibility?: boolean; signal?: AbortSignal },
  ): Promise<AppShotCapture>;
  captureActive(options?: {
    includeAccessibility?: boolean;
    signal?: AbortSignal;
  }): Promise<AppShotCapture | undefined>;
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
    imageSize?: AppShotImageSize;
    signal?: AbortSignal;
  }) => Promise<AppShotAccessibilityRead | undefined>;
  captureActiveNative?: (options?: {
    includeAccessibility?: boolean;
    signal?: AbortSignal;
  }) => Promise<AppShotCapture | undefined>;
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
    hasNativeActiveCapture: Boolean(
      dependencies.captureActiveNative || dependencies.getActiveWindow,
    ),
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
      if (!sameObservedWindow(active, after))
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
          const before = await dependencies.getWindowMetadata(
            selected.windowId,
          );
          if (
            before.windowId === selected.windowId &&
            before.windowTitle === selected.title &&
            before.pid > 0
          )
            expectedIdentity = before;
        } catch {
          /* Metadata is optional for an explicit screenshot. */
        }
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
      if (
        expectedIdentity &&
        dependencies.getWindowMetadata &&
        !sameObservedWindow(
          expectedIdentity,
          await dependencies.getWindowMetadata(selected.windowId),
        )
      )
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
      let accessibility: AppShotText | undefined;
      if (options?.includeAccessibility && dependencies.readAccessibility) {
        try {
          const read = await dependencies.readAccessibility({
            windowId: selected.windowId,
            windowTitle: selected.title,
            expectedIdentity,
            imageSize: appShotPngSize(bytes),
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
            if (read.format === "element-tree") {
              // Never slice JSON: the worker boundary already validated this complete payload.
              if (read.text.length <= MAX_AX_TEXT)
                accessibility = {
                  text: read.text,
                  format: read.format,
                  truncated: read.truncated === true,
                };
            } else {
              let text = read.text.replaceAll("\0", "").slice(0, MAX_AX_TEXT);
              if (/[\uD800-\uDBFF]/u.test(text.at(-1) ?? ""))
                text = text.slice(0, -1);
              accessibility = {
                text,
                truncated:
                  read.truncated === true || text.length < read.text.length,
              };
            }
          }
        } catch {
          // An AX failure cannot change the screenshot target or leak another app's text.
        }
      }
      if (options?.signal?.aborted) throw new Error("App Shot cancelled");
      const context = [
        `App Shot of external window "${plain(selected.title, 1000)}"${applicationName ? ` in ${applicationName}` : ""}.`,
        `Captured at: ${capturedAt}.`,
        accessibility?.text
          ? appShotAccessibilityContext(accessibility)
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
    captureActiveNative:
      process.platform === "win32"
        ? async (captureOptions) => {
            const { app, nativeImage } = await import("electron");
            const { captureWindowsActiveAppShot } =
              await import("./app-shot-native-capture.js");
            const shot = await captureWindowsActiveAppShot({
              workerPath: join(
                app.getAppPath(),
                "out/main/app-shot-native-worker.js",
              ),
              includeAccessibility: captureOptions?.includeAccessibility,
              signal: captureOptions?.signal,
              excludedWindowIds: (options.excludedSourceIds?.() ?? [])
                .map(windowIdOf)
                .filter((id): id is number => id !== undefined),
            });
            const image = nativeImage.createFromBuffer(shot.png);
            if (image.isEmpty())
              throw new Error("App Shot returned an empty image");
            const dimensions = fitAppShotDimensions(image.getSize());
            const resized = image.resize({ ...dimensions, quality: "best" });
            const png = resized.toPNG();
            if (!png.length || png.length > MAX_IMAGE_BYTES)
              throw new Error("App Shot image exceeds the byte budget");
            return windowsAppShotDraft(
              { ...shot, png, ...resized.getSize() },
              captureOptions?.includeAccessibility === true,
            );
          }
        : process.platform === "linux" && niriSocketPath()
          ? async (captureOptions) => {
              const { captureNiriActiveAppShot } =
                await import("./app-shot-niri.js");
              const shot = await captureNiriActiveAppShot({
                signal: captureOptions?.signal,
              });
              return niriAppShotDraft(
                shot,
                captureOptions?.includeAccessibility === true,
                captureOptions?.includeAccessibility
                  ? await readLinuxAppShotAccessibility(
                      niriAppShotIdentity(shot),
                      captureOptions?.signal,
                      { width: shot.width, height: shot.height },
                    )
                  : undefined,
              );
            }
          : process.platform === "linux" && isWaylandAppShotSession()
            ? async (captureOptions) => {
                const { app } = await import("electron");
                const { capturePortalActiveAppShot } =
                  await import("./app-shot-portal.js");
                const {
                  isGnomeAppShotSession,
                  checkGnomeAppShotSupport,
                  captureGnomeActiveAppShot,
                } = await import("./app-shot-gnome.js");
                const {
                  isKdeSession,
                  getKdeAppShotSupport,
                  captureKdeActiveAppShot,
                } = await import("./app-shot-kde.js");
                const {
                  isHyprlandSession,
                  getHyprlandAppShotState,
                  captureHyprlandActiveAppShot,
                } = await import("./app-shot-hyprland.js");
                // Match the capability/shortcut adapter's single desktop selection.
                const kde = isKdeSession();
                const hyprland = !kde && isHyprlandSession();
                return captureWaylandAppShot(
                  captureOptions?.includeAccessibility === true,
                  {
                    ...(kde
                      ? {
                          kdeSupport: () =>
                            getKdeAppShotSupport({
                              signal: captureOptions?.signal,
                            }),
                        }
                      : {}),
                    ...(hyprland
                      ? {
                          hyprlandSupport: () =>
                            getHyprlandAppShotState({
                              signal: captureOptions?.signal,
                            }),
                        }
                      : {}),
                    captureKde: () =>
                      captureKdeActiveAppShot({
                        signal: captureOptions?.signal,
                      }),
                    captureHyprland: () =>
                      captureHyprlandActiveAppShot({
                        signal: captureOptions?.signal,
                      }),
                    readNativeAccessibility: (shot) =>
                      readLinuxAppShotAccessibility(
                        nativeWaylandAppShotIdentity(shot),
                        captureOptions?.signal,
                        { width: shot.width, height: shot.height },
                      ),
                    ...(!kde && !hyprland && isGnomeAppShotSession()
                      ? {
                          gnomeSupport: () =>
                            checkGnomeAppShotSupport({
                              signal: captureOptions?.signal,
                            }),
                        }
                      : {}),
                    captureGnome: () =>
                      captureGnomeActiveAppShot({
                        development: !app.isPackaged,
                        signal: captureOptions?.signal,
                      }),
                    readGnomeAccessibility: (shot) =>
                      readLinuxAppShotAccessibility(
                        gnomeAppShotIdentity(shot),
                        captureOptions?.signal,
                        { width: shot.width, height: shot.height },
                      ),
                    capturePortal: () =>
                      capturePortalActiveAppShot({
                        appId: app.isPackaged
                          ? "io.github.albert_zen.ZenX"
                          : "io.github.albert_zen.ZenX.Development",
                        signal: captureOptions?.signal,
                      }),
                  },
                );
              }
            : undefined,
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
export function sameObservedWindow(
  a: AppShotActiveWindow,
  b: AppShotActiveWindow,
): boolean {
  return (
    a.windowId === b.windowId &&
    a.pid === b.pid &&
    a.windowTitle === b.windowTitle &&
    (a.bounds === undefined
      ? b.bounds === undefined
      : b.bounds !== undefined &&
        (["x", "y", "width", "height"] as const).every(
          (key) => a.bounds![key] === b.bounds![key],
        ))
  );
}

/** Captured PNG dimensions, never inferred from logical window geometry. */
function appShotPngSize(bytes: Uint8Array): AppShotImageSize | undefined {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    png.length < 33 ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    return undefined;
  const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  return isAppShotImageSize(size) ? size : undefined;
}

function appShotAccessibilityContext(read: AppShotText): string {
  const label =
    read.format === "element-tree"
      ? "Accessibility semantic tree"
      : "Accessibility text";
  return `${label} from this same window (read-only${read.truncated ? ", truncated" : ""}): ${read.text}`;
}

export function windowsAppShotDraft(
  shot: AppShotWindowsCapture,
  includeAccessibility: boolean,
): AppShotCapture {
  let accessibility = includeAccessibility ? shot.accessibility : undefined;
  if (accessibility?.format === "element-tree") {
    // Windows resizes its pixels after the AX read. Only the image envelope/root
    // changes here; descendant positions remain explicitly unavailable.
    try {
      const text = accessibility.text;
      accessibility = undefined;
      const payload: unknown =
        text.length <= APP_SHOT_MAX_TEXT ? JSON.parse(text) : undefined;
      if (
        isRecord(payload) &&
        isAppShotImageSize(payload.imageSize) &&
        parseAppShotAccessibility(payload, payload.imageSize)
      ) {
        const size = { width: shot.width, height: shot.height };
        payload.imageSize = size;
        (payload.root as Record<string, unknown>).bounds = {
          x: 0,
          y: 0,
          ...size,
        };
        accessibility = parseAppShotAccessibility(payload, size);
      }
    } catch {
      /* Invalid optional context remains screenshot-only. */
    }
  }
  const text = accessibility?.text;
  return {
    name: filename(shot.identity.windowTitle),
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      `App Shot of external window "${plain(shot.identity.windowTitle, 1000)}"${shot.identity.applicationName ? ` in ${plain(shot.identity.applicationName, 100)}` : ""}.`,
      `Captured at: ${new Date().toISOString()}.`,
      "Capture: visible desktop region at the foreground window bounds. Overlapping windows may appear in these pixels.",
      text
        ? appShotAccessibilityContext(accessibility!)
        : includeAccessibility
          ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
          : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}

/** T3's bounded semantic extraction in a disposable worker; never grants AX access. */
async function readMacAppShotAccessibility(request: {
  windowId: number;
  windowTitle: string;
  expectedIdentity?: AppShotActiveWindow;
  imageSize?: AppShotImageSize;
  signal?: AbortSignal;
}): Promise<AppShotAccessibilityRead | undefined> {
  const expected = request.expectedIdentity;
  if (!expected?.bounds) return undefined;
  const { readMacWindowMetadata } = await import("./app-shot-native.js");
  const metadata = await readMacWindowMetadata(request.windowId);
  if (!sameObservedWindow(expected, metadata)) return undefined;
  const { app } = await import("electron");
  const { readCapturedAppShotAccessibility } =
    await import("./app-shot-native-capture.js");
  const read = await readCapturedAppShotAccessibility(
    { ...expected, platform: "darwin", bounds: expected.bounds },
    {
      workerPath: join(app.getAppPath(), "out/main/app-shot-native-worker.js"),
      signal: request.signal,
      imageSize: request.imageSize,
    },
  );
  if (
    !read ||
    !sameObservedWindow(expected, await readMacWindowMetadata(request.windowId))
  )
    return undefined;
  return { ...expected, ...read };
}

/** T3's bounded image envelope, preserving aspect ratio without upscaling. */
export function fitAppShotDimensions(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  )
    throw new Error("App Shot image dimensions are invalid");
  const scale = Math.min(1, 2560 / size.width, 1600 / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Wayland AT-SPI matches verified title/size, never an invented screen origin. */
export function gnomeAppShotIdentity(
  shot: GnomeAppShotCapture,
): AppShotLinuxCaptureIdentity | undefined {
  const window = shot.window;
  if (!window || window.processId <= 0 || !window.title.trim())
    return undefined;
  return {
    platform: "linux",
    matchMode: "wayland",
    pid: window.processId,
    windowTitle: window.title,
    bounds: { width: window.bounds.width, height: window.bounds.height },
  };
}

/** KDE/Hyprland identities retain logical frame and client sizes, never global origins. */
export function nativeWaylandAppShotIdentity(
  shot: KdeAppShotCapture | HyprlandAppShotCapture,
): AppShotLinuxCaptureIdentity | undefined {
  const window = shot.window;
  if (
    !window ||
    !Number.isSafeInteger(window.processId) ||
    window.processId <= 0 ||
    !window.title.trim()
  )
    return undefined;
  return {
    platform: "linux",
    matchMode: "wayland",
    pid: window.processId,
    windowTitle: window.title,
    bounds: { width: window.bounds.width, height: window.bounds.height },
    clientBounds: {
      width: window.clientBounds.width,
      height: window.clientBounds.height,
    },
  };
}

export function nativeWaylandAppShotDraft(
  backend: "KDE" | "Hyprland",
  shot: KdeAppShotCapture | HyprlandAppShotCapture,
  includeAccessibility: boolean,
  accessibility?: AppShotText,
): AppShotCapture {
  const title =
    shot.window?.title || shot.window?.appName || `${backend} window`;
  return {
    name: filename(title),
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      shot.window
        ? `App Shot of ${backend} window "${plain(title, 1000)}"${shot.window.appName ? ` in ${plain(shot.window.appName, 100)}` : ""}.`
        : `App Shot of the ${backend} window selected at capture start. Window identity changed or was unavailable afterward; metadata is omitted.`,
      `Captured at: ${new Date().toISOString()}.`,
      includeAccessibility &&
      nativeWaylandAppShotIdentity(shot) &&
      accessibility?.text
        ? appShotAccessibilityContext(accessibility)
        : includeAccessibility
          ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
          : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}

export function niriAppShotIdentity(
  shot: NiriAppShotCapture,
): AppShotLinuxCaptureIdentity | undefined {
  const window = shot.window;
  if (!window?.pid || window.pid <= 0 || !window.title?.trim())
    return undefined;
  return {
    platform: "linux",
    matchMode: "wayland",
    windowId: window.id,
    pid: window.pid,
    windowTitle: window.title,
    bounds: { width: window.bounds.width, height: window.bounds.height },
  };
}

async function readLinuxAppShotAccessibility(
  identity: AppShotLinuxCaptureIdentity | undefined,
  signal?: AbortSignal,
  imageSize?: AppShotImageSize,
): Promise<AppShotText | undefined> {
  if (!identity || signal?.aborted) return undefined;
  const { app } = await import("electron");
  const { readCapturedAppShotAccessibility } =
    await import("./app-shot-native-capture.js");
  return readCapturedAppShotAccessibility(identity, {
    imageSize,
    workerPath: join(app.getAppPath(), "out/main/app-shot-native-worker.js"),
    signal,
  });
}

/** Prefer an installed compositor backend; never fall through after capture starts. */
export async function captureWaylandAppShot(
  includeAccessibility: boolean,
  dependencies: {
    kdeSupport?(): Promise<KdeAppShotSupport>;
    captureKde?(): Promise<KdeAppShotCapture>;
    hyprlandSupport?(): Promise<HyprlandAppShotState>;
    captureHyprland?(): Promise<HyprlandAppShotCapture>;
    readNativeAccessibility?(
      shot: KdeAppShotCapture | HyprlandAppShotCapture,
    ): Promise<AppShotText | undefined>;
    gnomeSupport?(): Promise<GnomeAppShotSupport>;
    captureGnome(): Promise<GnomeAppShotCapture>;
    readGnomeAccessibility?(
      shot: GnomeAppShotCapture,
    ): Promise<AppShotText | undefined>;
    capturePortal(): Promise<PortalAppShotCapture | undefined>;
  },
): Promise<AppShotCapture | undefined> {
  const kde = await dependencies.kdeSupport?.();
  if (kde?.status === "error") throw new Error(kde.message);
  if (kde?.status === "ready") {
    if (!dependencies.captureKde)
      throw new Error("KDE App Shot capture is unavailable");
    const shot = await dependencies.captureKde();
    const text =
      includeAccessibility && nativeWaylandAppShotIdentity(shot)
        ? await dependencies.readNativeAccessibility?.(shot)
        : undefined;
    return nativeWaylandAppShotDraft("KDE", shot, includeAccessibility, text);
  }
  const hyprland = await dependencies.hyprlandSupport?.();
  // Version probing can fail through denial or transport errors, not just absence.
  // Do not turn an installed but unusable helper into another capture target.
  if (hyprland?.status === "error" || hyprland?.status === "update-required")
    throw new Error(hyprland.message);
  if (hyprland?.status === "ready") {
    if (!dependencies.captureHyprland)
      throw new Error("Hyprland App Shot capture is unavailable");
    const shot = await dependencies.captureHyprland();
    const text =
      includeAccessibility && nativeWaylandAppShotIdentity(shot)
        ? await dependencies.readNativeAccessibility?.(shot)
        : undefined;
    return nativeWaylandAppShotDraft(
      "Hyprland",
      shot,
      includeAccessibility,
      text,
    );
  }
  if ((await dependencies.gnomeSupport?.())?.status === "ready") {
    const shot = await dependencies.captureGnome();
    const text =
      includeAccessibility && gnomeAppShotIdentity(shot)
        ? await dependencies.readGnomeAccessibility?.(shot)
        : undefined;
    return gnomeAppShotDraft(shot, includeAccessibility, text);
  }
  const shot = await dependencies.capturePortal();
  return shot ? portalAppShotDraft(shot, includeAccessibility) : undefined;
}

export function gnomeAppShotDraft(
  shot: GnomeAppShotCapture,
  includeAccessibility: boolean,
  accessibility?: AppShotText,
): AppShotCapture {
  const title = shot.window?.title || shot.window?.appName || "GNOME window";
  return {
    name: filename(title),
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      shot.window
        ? `App Shot of GNOME window "${plain(title, 1000)}"${shot.window.appName ? ` in ${plain(shot.window.appName, 100)}` : ""}.`
        : "App Shot of the GNOME window selected at capture start. No verified window identity was supplied; metadata is omitted.",
      `Captured at: ${new Date().toISOString()}.`,
      includeAccessibility && gnomeAppShotIdentity(shot) && accessibility?.text
        ? appShotAccessibilityContext(accessibility)
        : includeAccessibility
          ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
          : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}

export function niriAppShotDraft(
  shot: NiriAppShotCapture,
  includeAccessibility: boolean,
  accessibility?: AppShotText,
): AppShotCapture {
  const title = shot.window?.title ?? shot.window?.appId ?? "Niri window";
  return {
    name: filename(title),
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      shot.window
        ? `App Shot of Niri window "${plain(title, 1000)}"${shot.window.appId ? ` in ${plain(shot.window.appId, 100)}` : ""}.`
        : "App Shot of the Niri window selected at capture start. Window identity changed or was unavailable afterward; metadata is omitted.",
      `Captured at: ${new Date().toISOString()}.`,
      includeAccessibility && niriAppShotIdentity(shot) && accessibility?.text
        ? appShotAccessibilityContext(accessibility)
        : includeAccessibility
          ? "Screenshot only. Accessibility text was unavailable or could not be matched to this window."
          : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}

/** T3's session detection, including launchers that omit the usual Wayland variables. */
export function isWaylandAppShotSession(
  env: NodeJS.ProcessEnv = process.env,
  probe = {
    entries: (directory: string) => readdirSync(directory),
    socket: (path: string) => lstatSync(path).isSocket(),
    unixSockets: () => readFileSync("/proc/net/unix", "utf8"),
  },
): boolean {
  const session = env["XDG_SESSION_TYPE"]?.toLowerCase();
  if (session === "wayland" || Boolean(env["WAYLAND_DISPLAY"])) return true;
  if (session === "x11") return false;
  const directory = env["XDG_RUNTIME_DIR"];
  if (!directory || !isAbsolute(directory)) return false;
  try {
    const sockets = new Set(
      probe
        .unixSockets()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).at(-1)),
    );
    return probe.entries(directory).some((name) => {
      if (!/^wayland-\d+$/.test(name)) return false;
      const path = join(directory, name);
      return sockets.has(path) && probe.socket(path);
    });
  } catch {
    return false;
  }
}

/** Generic portal pixels cannot be correlated with a guessed window or AX tree. */
export function portalAppShotDraft(
  shot: { png: Uint8Array; width: number; height: number },
  includeAccessibility: boolean,
): AppShotCapture {
  return {
    name: "App Shot.png",
    bytes: shot.png,
    mediaType: "image/png",
    context: [
      "App Shot of the active window selected by the desktop screenshot portal. The portal supplied no verified application or window identity.",
      `Captured at: ${new Date().toISOString()}.`,
      includeAccessibility
        ? "Screenshot only. Accessibility text cannot be matched to generic portal pixels."
        : "Screenshot only. Accessibility text was not requested.",
      "This is a draft attachment, not permission to control the app.",
    ].join("\n"),
  };
}
