import { randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

import type { BrowserWindow, Session } from "electron";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

export interface BrowserTabSummary {
  sessionId: string;
  tabId: string;
  title: string;
  url: string;
  loading: boolean;
}

export interface BrowserInspection extends BrowserTabSummary {
  observationId: string;
  documentVersion: number;
  visibleText: string;
  screenshot: BrowserScreenshotArtifact;
  targets: Array<{
    targetId: string;
    role: string;
    name: string;
    actions: Array<"click" | "type">;
    value?: string;
  }>;
}

export interface BrowserScreenshotArtifact {
  artifactPath: string;
  observationId: string;
  status: "captured" | "fallback";
  reason?: string;
  width: number;
  height: number;
  bytes: number;
  expiresAt: string;
}

export interface ZenXBrowserBackend {
  listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]>;
  open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection>;
  click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  closeTab(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<void> | void;
  closeSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<number> | number;
  close(): Promise<void> | void;
}

export const browserCapabilityManifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: "browser",
  displayName: "Browser",
  version: "1.0.0",
  description:
    "A dedicated ephemeral ZenX browser session with bounded DOM inspection and narrow navigation and interaction tools.",
  provider: {
    id: "electron-dedicated-browser",
    platforms: ["darwin", "win32", "linux"],
    interactionModes: ["background_safe"],
    capabilities: [
      "dedicated_profile",
      "cdp",
      "dom.inspect",
      "dom.navigate",
      "dom.interact",
    ],
  },
  permissions: [
    {
      id: "browser.tabs.read",
      title: "Inspect browser tabs",
      description:
        "List tabs and inspect bounded visible text and interactive targets.",
      scope: "browser-session",
    },
    {
      id: "browser.navigate",
      title: "Open and navigate pages",
      description:
        "Open URLs or navigate an explicitly targeted ZenX browser tab.",
      scope: "browser-session",
    },
    {
      id: "browser.interact",
      title: "Interact with pages",
      description:
        "Click and type into an explicitly targeted visible page element.",
      scope: "browser-session",
    },
  ],
  tools: [
    {
      name: "browser_list_tabs",
      description:
        "List bounded metadata for tabs in one explicit ZenX browser session. Cookies, storage, headers, and history are never returned.",
      inputSchema: objectSchema({ sessionId: stringSchema() }, ["sessionId"]),
      permissions: ["browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "tab_metadata.read"],
      maxOutputBytes: 8 * 1024,
    },
    {
      name: "browser_open",
      description:
        "Open an http(s) URL in a hidden tab in an explicit ephemeral ZenX browser session. Returns the new tabId without activating an app window.",
      inputSchema: objectSchema(
        { sessionId: stringSchema(), url: stringSchema() },
        ["sessionId", "url"],
      ),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.navigate"],
    },
    {
      name: "browser_navigate",
      description:
        "Navigate one explicit ZenX browser session/tab target to an http(s) URL.",
      inputSchema: browserTargetSchema({ url: stringSchema() }, ["url"]),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.navigate"],
    },
    {
      name: "browser_inspect",
      description:
        "Create the latest bounded observation for one ZenX browser tab and return opaque target IDs for visible controls. Existing input values are not returned.",
      inputSchema: browserTargetSchema(),
      permissions: ["browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.inspect"],
      maxOutputBytes: 12 * 1024,
    },
    {
      name: "browser_click",
      description:
        "Click one visible, clickable opaque target from the latest browser_inspect observation. Stale, forged, hidden, or changed targets fail closed.",
      inputSchema: browserTargetSchema(
        { observationId: stringSchema(), targetId: stringSchema() },
        ["observationId", "targetId"],
      ),
      permissions: ["browser.interact"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.click"],
    },
    {
      name: "browser_type",
      description:
        "Replace the value in one visible, typeable opaque target from the latest browser_inspect observation, optionally submitting its form. Text is dispatched as an ordinary tool argument regardless of field metadata.",
      inputSchema: browserTargetSchema(
        {
          observationId: stringSchema(),
          targetId: stringSchema(),
          text: stringSchema(),
          submit: { type: "boolean" },
        },
        ["observationId", "targetId", "text"],
      ),
      permissions: ["browser.interact"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.set_value"],
    },
    {
      name: "browser_close",
      description:
        "Close one explicit ZenX browser tab and invalidate its latest observation.",
      inputSchema: browserTargetSchema(),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "tab.close"],
    },
    {
      name: "browser_close_session",
      description:
        "Close every hidden tab in one explicit ZenX browser session, clear its storage/cache, and ensure reopening the same sessionId uses a fresh partition.",
      inputSchema: objectSchema({ sessionId: stringSchema() }, ["sessionId"]),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "session.close"],
    },
  ],
  resources: [
    {
      id: "safe-browser-use",
      kind: "skill",
      title: "Safe browser use",
      description:
        "Instructions for targeted, inspect-before-act browser automation.",
      content:
        "Choose a stable sessionId for the task. List or open tabs, then inspect the exact tab before clicking or typing. Act only with the observationId and opaque targetId from the latest inspect; re-inspect after navigation or every action. Text is dispatched as an ordinary tool argument regardless of field metadata. Close tabs or the session when done; close_session clears the current partition so a later same-ID session starts clean. Never ask for cookies, storage state, auth headers, or hidden page content.",
    },
    {
      id: "browser-research",
      kind: "prompt",
      title: "Browser research prompt",
      description: "A reusable prompt for evidence-backed browser research.",
      content:
        "Research the requested topic in the dedicated ZenX browser session. Keep a list of the exact page URLs inspected, distinguish page evidence from inference, and summarize only visible content returned by browser_inspect.",
    },
  ],
};

export class BrowserZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXCapabilityManifest;
  readonly #backend: ZenXBrowserBackend;

  constructor(
    backend: ZenXBrowserBackend,
    manifest: ZenXCapabilityManifest = browserCapabilityManifest,
  ) {
    this.#backend = backend;
    this.manifest = manifest;
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    const sessionId = requiredTargetId(invocation.arguments, "sessionId");
    switch (toolName) {
      case "browser_list_tabs":
        return await this.#backend.listTabs(sessionId, invocation.signal);
      case "browser_open":
        return await this.#backend.open(
          sessionId,
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
          invocation.signal,
        );
      case "browser_navigate":
        return await this.#backend.navigate(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
          invocation.signal,
        );
      case "browser_inspect":
        return await this.#backend.inspect(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          invocation.signal,
        );
      case "browser_click":
        return await this.#backend.click(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          requiredTargetId(invocation.arguments, "targetId"),
          invocation.signal,
        );
      case "browser_type":
        return await this.#backend.type(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          requiredTargetId(invocation.arguments, "targetId"),
          requiredString(invocation.arguments, "text", true),
          optionalBoolean(invocation.arguments, "submit") ?? false,
          invocation.signal,
        );
      case "browser_close": {
        const tabId = requiredTargetId(invocation.arguments, "tabId");
        await this.#backend.closeTab(sessionId, tabId, invocation.signal);
        return { closed: true, sessionId, tabId };
      }
      case "browser_close_session":
        return {
          closedTabs: await this.#backend.closeSession(
            sessionId,
            invocation.signal,
          ),
          sessionId,
        };
      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}

interface BrowserTab {
  sessionId: string;
  tabId: string;
  window: BrowserWindow;
  incarnation: BrowserSessionIncarnation;
  documentVersion: number;
  observation?: BrowserObservation;
}

interface BrowserSessionIncarnation {
  generation: number;
  partition: string;
  pending: number;
  invalidated: boolean;
}

export interface BrowserTargetFingerprint {
  selector: string;
  tag: string;
  role: string;
  name: string;
  type: string;
  id: string;
  fieldName: string;
  autocomplete: string;
  href: string;
  actions: Array<"click" | "type">;
  value?: string;
}

export interface BrowserObservation {
  id: string;
  documentVersion: number;
  targets: Map<string, BrowserTargetFingerprint>;
}

export const MAX_BROWSER_TABS_PER_SESSION = 8;
export const MAX_BROWSER_TABS_GLOBAL = 24;
export const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const BROWSER_SCREENSHOT_TTL_MS = 5 * 60_000;
export const MAX_BROWSER_SCREENSHOT_ARTIFACTS = 16;
export const MAX_BROWSER_SCREENSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_SCOPES = 256;
const MAX_BROWSER_SCREENSHOT_WIDTH = 4096;
const MAX_BROWSER_SCREENSHOT_HEIGHT = 4096;
const MAX_BROWSER_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const MAX_BROWSER_SCREENSHOT_DECODE_BYTES = 64 * 1024 * 1024;
let activeBrowserScreenshotDecodeBytes = 0;

/** Temporary provider-owned PNGs; no screenshot bytes are part of the journal. */
export class BrowserScreenshotArtifactStore {
  readonly #rootDirectory: string;
  readonly #directory: string;
  readonly #ownsRootDirectory: boolean;
  readonly #artifacts = new Map<
    string,
    {
      scope: string;
      observationId: string;
      bytes: number;
      createdAt: number;
      timer: NodeJS.Timeout;
    }
  >();
  #directoryCreated = false;
  #closed = false;
  #totalBytes = 0;
  #operations: Promise<void> = Promise.resolve();
  #generation = 0;
  readonly #scopeGenerations = new Map<string, number>();

  constructor(directory?: string) {
    this.#rootDirectory =
      directory ??
      path.join(
        os.tmpdir(),
        `zenx-browser-artifacts-${String(process.pid)}-${randomUUID()}`,
      );
    this.#directory = path.join(this.#rootDirectory, `store-${randomUUID()}`);
    this.#ownsRootDirectory = directory === undefined;
  }

  async write(
    scope: string,
    observationId: string,
    png: Buffer,
    options: { status?: "captured" | "fallback"; reason?: string } = {},
  ): Promise<BrowserScreenshotArtifact> {
    const generation = this.#generation;
    const scopeGeneration = this.#scopeGeneration(scope);
    return await this.#enqueue(async () => {
      if (this.#closed || generation !== this.#generation) {
        throw new Error("Browser screenshot artifact store is closed");
      }
      if (scopeGeneration !== this.#scopeGeneration(scope)) {
        throw new Error(
          "Browser screenshot observation scope is no longer current",
        );
      }
      if (png.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
        throw new Error(
          `Browser screenshot exceeded the ${String(MAX_BROWSER_SCREENSHOT_BYTES)} byte bound`,
        );
      }
      const dimensions = pngDimensions(png);
      if (!this.#directoryCreated) {
        await this.#ensureOwnedDirectory();
        this.#directoryCreated = true;
      }
      await this.#assertOwnedDirectory();
      if (
        png.byteLength > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES ||
        this.#artifacts.size >= MAX_BROWSER_SCREENSHOT_ARTIFACTS ||
        this.#totalBytes + png.byteLength > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES
      ) {
        await this.#evictFor(png.byteLength);
      }
      const artifactPath = path.join(this.#directory, `${randomUUID()}.png`);
      if (
        this.#closed ||
        generation !== this.#generation ||
        scopeGeneration !== this.#scopeGeneration(scope)
      ) {
        throw new Error(
          "Browser screenshot artifact store was closed during capture",
        );
      }
      const openFlags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(artifactPath, openFlags, 0o600);
      try {
        await this.#assertOwnedDirectory();
        await handle.writeFile(png);
        const written = await handle.stat();
        if (!written.isFile() || written.size !== png.byteLength) {
          throw new Error("Browser screenshot artifact write was not complete");
        }
      } finally {
        await handle.close();
      }
      await this.#assertOwnedDirectory();
      if (
        this.#closed ||
        generation !== this.#generation ||
        scopeGeneration !== this.#scopeGeneration(scope)
      ) {
        await rm(artifactPath, { force: true });
        throw new Error("Browser screenshot artifact store is closed");
      }
      const expiresAt = new Date(Date.now() + BROWSER_SCREENSHOT_TTL_MS);
      const timer = setTimeout(() => {
        void this.removeArtifact(artifactPath, observationId);
      }, BROWSER_SCREENSHOT_TTL_MS);
      timer.unref();
      this.#artifacts.set(artifactPath, {
        scope,
        observationId,
        bytes: png.byteLength,
        createdAt: Date.now(),
        timer,
      });
      this.#totalBytes += png.byteLength;
      const superseded = [...this.#artifacts.entries()]
        .filter(
          ([candidatePath, artifact]) =>
            candidatePath !== artifactPath &&
            (artifact.scope === scope ||
              artifact.scope.startsWith(`${scope}/`)),
        )
        .map(([candidatePath]) => candidatePath);
      await Promise.all(
        superseded.map((candidatePath) => this.#removeNow(candidatePath)),
      );
      return {
        artifactPath,
        observationId,
        status: options.status ?? "captured",
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        width: dimensions.width,
        height: dimensions.height,
        bytes: png.byteLength,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async clearScope(scope: string): Promise<void> {
    this.#incrementScopeGeneration(scope);
    await this.#enqueue(async () => {
      const paths = [...this.#artifacts.entries()]
        .filter(
          ([, artifact]) =>
            artifact.scope === scope || artifact.scope.startsWith(`${scope}/`),
        )
        .map(([artifactPath]) => artifactPath);
      await Promise.all(
        paths.map((artifactPath) => this.#removeNow(artifactPath)),
      );
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    await this.#enqueue(async () => {
      for (const artifact of this.#artifacts.values())
        clearTimeout(artifact.timer);
      const paths = [...this.#artifacts.keys()];
      this.#artifacts.clear();
      this.#totalBytes = 0;
      await Promise.all(
        paths.map((artifactPath) => rm(artifactPath, { force: true })),
      );
      if (this.#directoryCreated) {
        await rm(this.#directory, { recursive: true, force: true });
        this.#directoryCreated = false;
      }
      if (this.#ownsRootDirectory) {
        await rm(this.#rootDirectory, { recursive: true, force: true });
      }
    });
  }

  async removeArtifact(
    artifactPath: string,
    observationId: string,
  ): Promise<void> {
    await this.#enqueue(async () => {
      const artifact = this.#artifacts.get(artifactPath);
      if (artifact === undefined || artifact.observationId !== observationId)
        return;
      await this.#removeNow(artifactPath);
    });
  }

  async #removeNow(artifactPath: string): Promise<void> {
    const artifact = this.#artifacts.get(artifactPath);
    if (artifact === undefined) return;
    clearTimeout(artifact.timer);
    this.#artifacts.delete(artifactPath);
    this.#totalBytes -= artifact.bytes;
    await rm(artifactPath, { force: true });
  }

  async #ensureOwnedDirectory(): Promise<void> {
    let root: Awaited<ReturnType<typeof lstat>>;
    try {
      root = await lstat(this.#rootDirectory);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(this.#rootDirectory, { mode: 0o700 });
      root = await lstat(this.#rootDirectory);
    }
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(
        "Browser screenshot artifact root must be a real directory",
      );
    }
    await chmod(this.#rootDirectory, 0o700);
    await mkdir(this.#directory, { recursive: false, mode: 0o700 });
    const child = await lstat(this.#directory);
    if (!child.isDirectory() || child.isSymbolicLink()) {
      throw new Error(
        "Browser screenshot artifact directory must be a real directory",
      );
    }
    await chmod(this.#directory, 0o700);
    await this.#assertOwnedDirectory();
  }

  async #assertOwnedDirectory(): Promise<void> {
    if (!this.#directoryCreated && !this.#directory) return;
    const root = await lstat(this.#rootDirectory);
    const child = await lstat(this.#directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      !child.isDirectory() ||
      child.isSymbolicLink()
    ) {
      throw new Error(
        "Browser screenshot artifact directory ownership changed",
      );
    }
    const [rootRealPath, childRealPath] = await Promise.all([
      realpath(this.#rootDirectory),
      realpath(this.#directory),
    ]);
    if (!isWithin(rootRealPath, childRealPath)) {
      throw new Error(
        "Browser screenshot artifact directory escaped its owner",
      );
    }
  }

  #scopeGeneration(scope: string): string {
    return [...this.#scopeGenerations.entries()]
      .filter(
        ([candidate]) =>
          scope === candidate || scope.startsWith(`${candidate}/`),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidate, generation]) => `${candidate}:${String(generation)}`)
      .join("|");
  }

  #incrementScopeGeneration(scope: string): void {
    if (
      !this.#scopeGenerations.has(scope) &&
      this.#scopeGenerations.size >= MAX_BROWSER_SCREENSHOT_SCOPES
    ) {
      throw new Error("Browser screenshot scope lifecycle bound exceeded");
    }
    this.#scopeGenerations.set(
      scope,
      (this.#scopeGenerations.get(scope) ?? 0) + 1,
    );
  }

  async #evictFor(bytes: number): Promise<void> {
    if (bytes > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES) {
      throw new Error("Browser screenshot aggregate byte bound exceeded");
    }
    const candidates = [...this.#artifacts.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    );
    while (
      this.#artifacts.size >= MAX_BROWSER_SCREENSHOT_ARTIFACTS ||
      this.#totalBytes + bytes > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES
    ) {
      const candidate = candidates.shift();
      if (candidate === undefined) {
        throw new Error("Browser screenshot artifact capacity is exhausted");
      }
      await this.#removeNow(candidate[0]);
    }
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

export class ElectronBrowserBackend implements ZenXBrowserBackend {
  readonly #tabs = new Map<string, BrowserTab>();
  readonly #sessions = new Map<string, BrowserSessionIncarnation>();
  readonly #artifacts: BrowserScreenshotArtifactStore;
  #pendingGlobal = 0;
  #nextSessionGeneration = 1;
  #closing = false;

  constructor(options: { artifactDirectory?: string } = {}) {
    this.#artifacts = new BrowserScreenshotArtifactStore(
      options.artifactDirectory,
    );
  }

  async listTabs(sessionId: string): Promise<BrowserTabSummary[]> {
    assertTargetId(sessionId, "sessionId");
    return [...this.#tabs.values()]
      .filter((tab) => tab.sessionId === sessionId && !tab.window.isDestroyed())
      .map((tab) => summarizeTab(tab));
  }

  async open(sessionId: string, url: string): Promise<BrowserTabSummary> {
    assertTargetId(sessionId, "sessionId");
    const incarnation = this.#reserveOpen(sessionId);
    const tabId = randomUUID();
    try {
      const { BrowserWindow } = await import("electron");
      const window = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 640,
        minHeight: 480,
        show: false,
        focusable: false,
        skipTaskbar: true,
        title: "ZenX Browser",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: incarnation.partition,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const tab: BrowserTab = {
        sessionId,
        tabId,
        window,
        incarnation,
        documentVersion: 0,
      };
      this.#tabs.set(tabId, tab);
      window.webContents.on(
        "did-start-navigation",
        (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) this.#invalidateDocument(tab);
        },
      );
      window.once("closed", () => {
        tab.observation = undefined;
        this.#tabs.delete(tabId);
        this.#releaseIncarnation(sessionId, incarnation);
      });
      await window.loadURL(url);
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Runtime.enable");
      if (
        this.#closing ||
        incarnation.invalidated ||
        this.#sessions.get(sessionId) !== incarnation
      ) {
        window.destroy();
        throw new Error("Browser session was closed while its tab was opening");
      }
      return summarizeTab(tab);
    } catch (error) {
      const tab = this.#tabs.get(tabId);
      if (tab !== undefined && !tab.window.isDestroyed()) tab.window.destroy();
      throw error;
    } finally {
      this.#releaseOpen(sessionId, incarnation);
    }
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#invalidateDocument(tab);
    await tab.window.loadURL(url);
    return summarizeTab(tab);
  }

  async inspect(sessionId: string, tabId: string): Promise<BrowserInspection> {
    const tab = this.#requireTab(sessionId, tabId);
    const documentVersion = tab.documentVersion;
    const inspected = await evaluateInTab<{
      visibleText: string;
      targets: BrowserTargetFingerprint[];
    }>(tab, browserInspectScript);
    const observationId = randomUUID();
    const screenshot = await this.#captureScreenshot(tab, observationId);
    if (tab.documentVersion !== documentVersion) {
      await this.#artifacts.removeArtifact(
        screenshot.artifactPath,
        screenshot.observationId,
      );
      throw new Error(
        "Browser document changed during inspection; inspect again",
      );
    }
    const targets = new Map<string, BrowserTargetFingerprint>();
    const projectedTargets = inspected.targets.slice(0, 80).map((target) => {
      const targetId = randomUUID();
      targets.set(targetId, target);
      return {
        targetId,
        role: target.role,
        name: target.name,
        actions: [...target.actions],
        ...(target.value === undefined ? {} : { value: target.value }),
      };
    });
    tab.observation = {
      id: observationId,
      documentVersion: tab.documentVersion,
      targets,
    };
    return {
      ...summarizeTab(tab),
      observationId,
      documentVersion: tab.documentVersion,
      visibleText: inspected.visibleText.slice(0, 8_000),
      screenshot,
      targets: projectedTargets,
    };
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    const target = this.#requireObservedTarget(
      tab,
      observationId,
      targetId,
      "click",
    );
    tab.observation = undefined;
    const result = await evaluateInTab<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, "click"),
    );
    if (!result.ok) {
      throw new Error(
        `Browser click target is stale or unsafe: ${result.reason}`,
      );
    }
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    const target = this.#requireObservedTarget(
      tab,
      observationId,
      targetId,
      "type",
    );
    tab.observation = undefined;
    const result = await evaluateInTab<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, "type", text, submit),
    );
    if (!result.ok) {
      throw new Error(
        `Browser type target is stale or unsafe: ${result.reason}`,
      );
    }
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async closeTab(sessionId: string, tabId: string): Promise<void> {
    const tab = this.#requireTab(sessionId, tabId);
    tab.observation = undefined;
    this.#tabs.delete(tabId);
    if (!tab.window.isDestroyed()) tab.window.destroy();
    this.#releaseIncarnation(sessionId, tab.incarnation);
    await this.#artifacts.clearScope(`${sessionId}/${tabId}`);
  }

  async closeSession(sessionId: string): Promise<number> {
    assertTargetId(sessionId, "sessionId");
    const incarnation = this.#sessions.get(sessionId);
    if (incarnation !== undefined) incarnation.invalidated = true;
    this.#sessions.delete(sessionId);
    const tabs = [...this.#tabs.values()].filter(
      (tab) => tab.sessionId === sessionId,
    );
    const electronSessions = new Set(
      tabs.map((tab) => tab.window.webContents.session),
    );
    await Promise.all(tabs.map((tab) => this.closeTab(sessionId, tab.tabId)));
    await Promise.all([...electronSessions].map(clearElectronSession));
    await this.#artifacts.clearScope(sessionId);
    return tabs.length;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const incarnation of this.#sessions.values()) {
      incarnation.invalidated = true;
    }
    this.#sessions.clear();
    const electronSessions = new Set(
      [...this.#tabs.values()].map((tab) => tab.window.webContents.session),
    );
    for (const tab of this.#tabs.values()) {
      tab.observation = undefined;
      if (!tab.window.isDestroyed()) tab.window.destroy();
    }
    this.#tabs.clear();
    await Promise.all([...electronSessions].map(clearElectronSession));
    await this.#artifacts.close();
  }

  async #captureScreenshot(
    tab: BrowserTab,
    observationId: string,
  ): Promise<BrowserScreenshotArtifact> {
    const image = await tab.window.webContents.capturePage();
    let png = image.toPNG();
    if (png.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
      const size = image.getSize();
      const scale = Math.sqrt(MAX_BROWSER_SCREENSHOT_BYTES / png.byteLength);
      if (scale < 1 && size.width > 1 && size.height > 1) {
        png = image
          .resize({
            width: Math.max(1, Math.floor(size.width * scale)),
            height: Math.max(1, Math.floor(size.height * scale)),
          })
          .toPNG();
      }
    }
    return await this.#artifacts.write(
      `${tab.sessionId}/${tab.tabId}`,
      observationId,
      png,
    );
  }

  #requireTab(sessionId: string, tabId: string): BrowserTab {
    assertTargetId(sessionId, "sessionId");
    assertTargetId(tabId, "tabId");
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.sessionId !== sessionId ||
      tab.window.isDestroyed()
    ) {
      throw new Error(`Unknown browser target ${sessionId}/${tabId}`);
    }
    return tab;
  }

  #requireObservedTarget(
    tab: BrowserTab,
    observationId: string,
    targetId: string,
    action: "click" | "type",
  ): BrowserTargetFingerprint {
    return resolveBrowserObservedTarget(
      tab.observation,
      tab.documentVersion,
      observationId,
      targetId,
      action,
    );
  }

  #invalidateDocument(tab: BrowserTab): void {
    tab.documentVersion += 1;
    tab.observation = undefined;
  }

  #reserveOpen(sessionId: string): BrowserSessionIncarnation {
    if (this.#closing) throw new Error("ZenX browser backend is closed");
    const existing = this.#sessions.get(sessionId);
    const currentGlobal = this.#tabs.size + this.#pendingGlobal;
    const currentSession =
      [...this.#tabs.values()].filter((tab) => tab.sessionId === sessionId)
        .length + (existing?.pending ?? 0);
    assertBrowserTabCapacity(currentGlobal, currentSession);
    const incarnation = existing ?? this.#createIncarnation(sessionId);
    this.#pendingGlobal += 1;
    incarnation.pending += 1;
    return incarnation;
  }

  #releaseOpen(
    sessionId: string,
    incarnation: BrowserSessionIncarnation,
  ): void {
    this.#pendingGlobal -= 1;
    incarnation.pending -= 1;
    this.#releaseIncarnation(sessionId, incarnation);
  }

  #createIncarnation(sessionId: string): BrowserSessionIncarnation {
    if (!Number.isSafeInteger(this.#nextSessionGeneration)) {
      throw new Error("ZenX browser session generation space is exhausted");
    }
    const generation = this.#nextSessionGeneration;
    this.#nextSessionGeneration += 1;
    const incarnation = {
      generation,
      partition: browserPartitionName(sessionId, generation),
      pending: 0,
      invalidated: false,
    };
    this.#sessions.set(sessionId, incarnation);
    return incarnation;
  }

  #releaseIncarnation(
    sessionId: string,
    incarnation: BrowserSessionIncarnation,
  ): void {
    if (
      this.#sessions.get(sessionId) !== incarnation ||
      incarnation.pending > 0 ||
      [...this.#tabs.values()].some((tab) => tab.incarnation === incarnation)
    ) {
      return;
    }
    incarnation.invalidated = true;
    this.#sessions.delete(sessionId);
  }
}

export function resolveBrowserObservedTarget(
  observation: BrowserObservation | undefined,
  documentVersion: number,
  observationId: string,
  targetId: string,
  action: "click" | "type",
): BrowserTargetFingerprint {
  if (
    observation === undefined ||
    observation.id !== observationId ||
    observation.documentVersion !== documentVersion
  ) {
    throw new Error(
      "Browser observation is stale or unknown; inspect the current tab again",
    );
  }
  const target = observation.targets.get(targetId);
  if (target === undefined) {
    throw new Error("Browser target ID is forged, stale, or unknown");
  }
  if (!target.actions.includes(action)) {
    throw new Error(`Browser target does not support ${action}`);
  }
  return target;
}

export const browserInspectScript = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const name = (element) => (element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 160);
  const typeable = (element) => {
    if (element.hasAttribute("disabled") || element.hasAttribute("readonly")) return false;
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return !["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(element.type.toLowerCase());
  };
  const clickable = (element) => getComputedStyle(element).pointerEvents !== "none" && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true" && element.matches("a[href],button,input:not([type=hidden]),select,[role=button],[tabindex]");
  const selector = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current instanceof Element && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + String(siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const elements = [...document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[tabindex]")]
    .filter(visible)
    .slice(0, 80);
  return {
    visibleText: (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 8000),
    targets: elements.map((element) => {
      const actions = [];
      if (clickable(element)) actions.push("click");
      if (typeable(element)) actions.push("type");
      return {
        selector: selector(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        name: name(element),
        type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
        id: element.id,
        fieldName: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.name : "",
        autocomplete: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.autocomplete : "",
        href: element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "",
        actions,
      };
    }),
  };
})()`;

export function browserActionScript(
  target: BrowserTargetFingerprint,
  action: "click" | "type",
  text = "",
  submit = false,
): string {
  const expected = JSON.stringify({
    tag: target.tag,
    role: target.role,
    name: target.name,
    type: target.type,
    id: target.id,
    fieldName: target.fieldName,
    autocomplete: target.autocomplete,
    href: target.href,
  });
  return `(() => {
    const expected = ${expected};
    const selector = ${JSON.stringify(target.selector)};
    const action = ${JSON.stringify(action)};
    const nextValue = ${JSON.stringify(text)};
    const shouldSubmit = ${JSON.stringify(submit)};
    const candidates = [...document.querySelectorAll(selector)];
    if (candidates.length !== 1) return { ok: false, reason: candidates.length === 0 ? "missing" : "ambiguous" };
    const element = candidates[0];
    if (!(element instanceof HTMLElement)) return { ok: false, reason: "not-an-html-element" };
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.hidden || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return { ok: false, reason: "not-visible" };
    const actual = {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
      name: (element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
      type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
      id: element.id,
      fieldName: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.name : "",
      autocomplete: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.autocomplete : "",
      href: element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "",
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return { ok: false, reason: "identity-changed" };
    if (action === "click") {
      if (style.pointerEvents === "none" || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || !element.matches("a[href],button,input:not([type=hidden]),select,[role=button],[tabindex]")) return { ok: false, reason: "not-clickable" };
      element.click();
      return { ok: true };
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.disabled || element.readOnly) return { ok: false, reason: "not-typeable" };
    if (element instanceof HTMLInputElement && ["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(element.type.toLowerCase())) return { ok: false, reason: "not-typeable" };
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) return { ok: false, reason: "value-setter-unavailable" };
    setter.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (shouldSubmit) element.form?.requestSubmit();
    return { ok: true };
  })()`;
}

export function assertBrowserTabCapacity(
  currentGlobal: number,
  currentSession: number,
): void {
  if (currentGlobal >= MAX_BROWSER_TABS_GLOBAL) {
    throw new Error(
      `ZenX browser global tab limit (${MAX_BROWSER_TABS_GLOBAL}) reached; close a tab or session before opening another`,
    );
  }
  if (currentSession >= MAX_BROWSER_TABS_PER_SESSION) {
    throw new Error(
      `ZenX browser session tab limit (${MAX_BROWSER_TABS_PER_SESSION}) reached; close a tab before opening another`,
    );
  }
}

export function browserPartitionName(
  sessionId: string,
  generation: number,
): string {
  assertTargetId(sessionId, "sessionId");
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Browser session generation must be a positive integer");
  }
  return `zenx-capability-${sessionId}-${String(generation)}`;
}

function summarizeTab(tab: BrowserTab): BrowserTabSummary {
  return {
    sessionId: tab.sessionId,
    tabId: tab.tabId,
    title: tab.window.getTitle().slice(0, 256),
    url: redactBrowserUrl(tab.window.webContents.getURL()),
    loading: tab.window.webContents.isLoading(),
  };
}

function safeBrowserUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZenX browser only opens http(s) URLs");
  }
  return url.toString();
}

export function redactBrowserUrl(raw: string): string {
  if (raw.length === 0) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString().slice(0, 2048);
  } catch {
    return "[malformed-url]";
  }
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Browser screenshot is not a valid PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawData = false;
  let ended = false;
  let sawPalette = false;
  let sawImageData = false;
  let paletteEntries = 0;
  let sawTransparency = false;
  let sawPostImageData = false;
  let chunkCount = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    chunkCount += 1;
    if (chunkCount > 1024) {
      throw new Error("Browser screenshot PNG has too many chunks");
    }
    if (offset + 12 > buffer.length) {
      throw new Error("Browser screenshot PNG is truncated");
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > buffer.length) {
      throw new Error("Browser screenshot PNG chunk is truncated");
    }
    if (ended) throw new Error("Browser screenshot PNG has data after IEND");
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(Buffer.concat([type, data]));
    if (actualCrc !== expectedCrc) {
      throw new Error("Browser screenshot PNG chunk CRC is invalid");
    }
    const name = type.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(name)) {
      throw new Error("Browser screenshot PNG chunk type is invalid");
    }
    if (
      (type[0]! & 0x20) === 0 &&
      !["IHDR", "PLTE", "IDAT", "IEND"].includes(name)
    ) {
      throw new Error(
        `Browser screenshot PNG has an unknown critical chunk ${name}`,
      );
    }
    if (!sawHeader && name !== "IHDR") {
      throw new Error("Browser screenshot PNG must begin with IHDR");
    }
    if (name === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new Error("Browser screenshot PNG IHDR is invalid");
      }
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_BROWSER_SCREENSHOT_WIDTH ||
        height > MAX_BROWSER_SCREENSHOT_HEIGHT ||
        width * height > MAX_BROWSER_SCREENSHOT_PIXELS ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0 ||
        !validPngBitDepth(colorType, bitDepth)
      ) {
        throw new Error("Browser screenshot dimensions or IHDR are invalid");
      }
      interlace = data[12]!;
    } else if (name === "IDAT") {
      if (!sawHeader || ended || sawPostImageData)
        throw new Error("Browser screenshot PNG IDAT is invalid");
      sawImageData = true;
      sawData = true;
      idat.push(data);
    } else if (name === "PLTE") {
      if (
        sawImageData ||
        sawPalette ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768
      ) {
        throw new Error("Browser screenshot PNG palette is invalid");
      }
      if (colorType === 0 || colorType === 4) {
        throw new Error(
          "Browser screenshot PNG palette is invalid for this color type",
        );
      }
      sawPalette = true;
      paletteEntries = length / 3;
    } else if (name === "tRNS") {
      if (
        sawImageData ||
        sawTransparency ||
        (colorType !== 3 && colorType !== 0 && colorType !== 2)
      ) {
        throw new Error("Browser screenshot PNG transparency is invalid");
      }
      sawTransparency = true;
      if (colorType === 3 && (!sawPalette || length > paletteEntries)) {
        throw new Error("Browser screenshot PNG transparency is invalid");
      }
      if (colorType === 0 && length !== 2) {
        throw new Error(
          "Browser screenshot PNG grayscale transparency is invalid",
        );
      }
      if (colorType === 2 && length !== 6) {
        throw new Error("Browser screenshot PNG RGB transparency is invalid");
      }
    } else if (name === "IEND") {
      if (!sawHeader || !sawData || length !== 0) {
        throw new Error("Browser screenshot PNG IEND is invalid");
      }
      ended = true;
    } else if (sawImageData) {
      sawPostImageData = true;
    }
    offset = crcEnd;
    if (ended) break;
  }
  if (!sawHeader || !sawData || !ended || offset !== buffer.length) {
    throw new Error("Browser screenshot PNG is incomplete");
  }
  if (colorType === 3 && !sawPalette) {
    throw new Error("Browser screenshot PNG palette is missing");
  }
  if (interlace !== 0) {
    throw new Error("Interlaced browser screenshots are unsupported");
  }
  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : 4;
  if (
    colorType === 3 &&
    (paletteEntries === 0 || paletteEntries > 1 << bitDepth)
  ) {
    throw new Error("Browser screenshot PNG palette entries are invalid");
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const decodedBytes = (rowBytes + 1) * height;
  if (decodedBytes > MAX_BROWSER_SCREENSHOT_DECODE_BYTES) {
    throw new Error("Browser screenshot decoded image exceeds the byte bound");
  }
  if (
    activeBrowserScreenshotDecodeBytes + decodedBytes >
    MAX_BROWSER_SCREENSHOT_DECODE_BYTES
  ) {
    throw new Error("Browser screenshot decode budget is exhausted");
  }
  activeBrowserScreenshotDecodeBytes += decodedBytes;
  try {
    const decoded = inflateSync(Buffer.concat(idat), {
      maxOutputLength: decodedBytes,
    });
    if (decoded.byteLength !== decodedBytes) {
      throw new Error("decoded byte count differs from image dimensions");
    }
    validatePngScanlines(
      decoded,
      width,
      height,
      rowBytes,
      channels,
      bitDepth,
      colorType,
      paletteEntries,
    );
  } catch (error) {
    throw new Error(
      `Browser screenshot PNG image data is not decodable: ${describeError(error)}`,
    );
  } finally {
    activeBrowserScreenshotDecodeBytes -= decodedBytes;
  }
  return { width, height };
}

function validatePngScanlines(
  decoded: Buffer,
  width: number,
  height: number,
  rowBytes: number,
  channels: number,
  bitDepth: number,
  colorType: number,
  paletteEntries: number,
): void {
  const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const previous = Buffer.alloc(rowBytes);
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[offset++];
    if (filter === undefined || filter > 4) {
      throw new Error("decoded scanline filter is invalid");
    }
    const source = decoded.subarray(offset, offset + rowBytes);
    if (source.byteLength !== rowBytes)
      throw new Error("decoded scanline is truncated");
    const current = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel]! : 0;
      const up = previous[index] ?? 0;
      const upperLeft =
        index >= bytesPerPixel ? previous[index - bytesPerPixel]! : 0;
      const value = source[index]!;
      current[index] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 0xff
            : filter === 2
              ? (value + up) & 0xff
              : filter === 3
                ? (value + Math.floor((left + up) / 2)) & 0xff
                : (value + paethPredictor(left, up, upperLeft)) & 0xff;
    }
    if (colorType === 3)
      validatePaletteIndices(current, width, bitDepth, paletteEntries);
    current.copy(previous);
    offset += rowBytes;
  }
  if (offset !== decoded.byteLength)
    throw new Error("decoded scanline data has a trailing payload");
}

function validatePaletteIndices(
  row: Buffer,
  width: number,
  bitDepth: number,
  paletteEntries: number,
): void {
  if (bitDepth === 8) {
    for (let index = 0; index < width; index += 1) {
      if ((row[index] ?? paletteEntries) >= paletteEntries) {
        throw new Error("decoded palette index is out of range");
      }
    }
    return;
  }
  const mask = (1 << bitDepth) - 1;
  for (let index = 0; index < width; index += 1) {
    const bit = index * bitDepth;
    const value =
      (row[Math.floor(bit / 8)]! >> (8 - bitDepth - (bit % 8))) & mask;
    if (value >= paletteEntries)
      throw new Error("decoded palette index is out of range");
  }
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance)
    return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  if (![0, 2, 3, 4, 6].includes(colorType)) return false;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  return bitDepth === 8 || bitDepth === 16;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requiredTargetId(
  arguments_: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(arguments_, key);
  assertTargetId(value, key);
  return value;
}

function assertTargetId(value: string, key: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(value)) {
    throw new Error(`${key} must contain only letters, numbers, _ or -`);
  }
}

function requiredString(
  arguments_: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = arguments_[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function optionalBoolean(
  arguments_: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = arguments_[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function browserTargetSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return objectSchema(
    { sessionId: stringSchema(), tabId: stringSchema(), ...properties },
    ["sessionId", "tabId", ...required],
  );
}

async function clearElectronSession(session: Session): Promise<void> {
  await Promise.all([
    session.clearStorageData(),
    session.clearCache(),
    session.clearAuthCache(),
  ]);
  session.flushStorageData();
}

async function settlePage(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    window.webContents.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function evaluateInTab<T>(
  tab: BrowserTab,
  expression: string,
): Promise<T> {
  const response = (await tab.window.webContents.debugger.sendCommand(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  )) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string };
  };
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      `Browser CDP evaluation failed: ${response.exceptionDetails.text ?? response.result?.description ?? "unknown error"}`,
    );
  }
  return response.result?.value as T;
}
