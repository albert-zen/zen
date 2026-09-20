import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents, WebContentsView } from "electron";

import { ipcChannels } from "../preload/ipc.js";
import { observeElectronPage } from "./capabilities/browser-electron-observation.js";
import {
  assertBrowserObservation,
  browserActionScript,
  browserInspectScript,
  browserScrollScript,
  BrowserScreenshotArtifactStore,
  redactBrowserUrl,
  resolveBrowserObservedTarget,
  type BrowserInspection,
  type BrowserLiveObservationListener,
  type BrowserObservation,
  type BrowserScrollDirection,
  type BrowserTabSummary,
  type BrowserTargetAction,
  type BrowserTargetFingerprint,
  type ZenXBrowserBackend,
} from "./capabilities/browser-provider.js";

export interface WorkspaceBrowserTab {
  id: string;
  threadId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  sharedWithAgent: true;
  error?: string;
}
export type WorkspaceBrowserCommand =
  "list" | "new" | "navigate" | "back" | "forward" | "reload" | "close";

interface Tab {
  id: string;
  threadId: string;
  view: WebContentsView;
  owner?: Owner;
  documentVersion: number;
  observation?: BrowserObservation;
  error?: string;
}
interface Owner {
  window: BrowserWindow;
  active?: { tab: Tab; lease: string };
}
interface WorkspaceBrowserDependencies {
  createView(): WebContentsView;
  windowFor(sender: WebContents): BrowserWindow | null;
}

export function workspaceBrowserUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 8192)
    throw new Error("Enter a valid web address");
  const raw = input.trim();
  if (!raw || raw === "about:blank") return "about:blank";
  const candidate =
    /^[a-z][a-z0-9+.-]*:/i.test(raw) &&
    !/^(localhost|[\w.-]+\.[a-z]+):\d/i.test(raw)
      ? raw
      : `https://${raw}`;
  const url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use an HTTP or HTTPS address without embedded credentials",
    );
  return url.href;
}

/** One Thread-bound page registry shared by the visible view and Browser tools. */
export class WorkspaceBrowser implements ZenXBrowserBackend {
  readonly #owners = new Map<number, Owner>();
  readonly #tabs = new Map<string, Tab>();
  readonly #sessionThreads = new Map<string, string>();
  readonly #artifacts: BrowserScreenshotArtifactStore;
  readonly #dependencies: WorkspaceBrowserDependencies;

  constructor(options: {
    artifactDirectory?: string;
    dependencies: WorkspaceBrowserDependencies;
  }) {
    this.#artifacts = new BrowserScreenshotArtifactStore(
      options.artifactDirectory,
    );
    this.#dependencies = {
      createView: options.dependencies.createView,
      windowFor: options.dependencies.windowFor,
    };
  }

  bindThreadSession(sessionId: string, threadId: string): void {
    const existing = this.#sessionThreads.get(sessionId);
    if (existing !== undefined && existing !== threadId)
      throw new Error("Browser session is already bound to another Thread");
    this.#sessionThreads.set(sessionId, threadId);
  }

  #owner(sender: WebContents): Owner {
    const window = this.#dependencies.windowFor(sender);
    if (!window || window.webContents !== sender)
      throw new Error("Browser UI requires its owning window");
    let owner = this.#owners.get(sender.id);
    if (!owner) {
      owner = { window };
      this.#owners.set(sender.id, owner);
      const id = sender.id;
      window.once("closed", () => {
        this.#hide(owner!);
        for (const tab of this.#tabs.values()) {
          if (tab.owner === owner) tab.owner = undefined;
        }
        this.#owners.delete(id);
      });
      sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) this.#hide(owner!);
      });
    }
    return owner;
  }

  #hide(owner: Owner): void {
    if (!owner.active) return;
    owner.active.tab.view.setVisible(false);
    if (!owner.window.isDestroyed())
      owner.window.contentView.removeChildView(owner.active.tab.view);
    owner.active = undefined;
  }

  #workspaceSnapshot(threadId: string): WorkspaceBrowserTab[] {
    return [...this.#tabs.values()]
      .filter(
        (tab) =>
          tab.threadId === threadId && !tab.view.webContents.isDestroyed(),
      )
      .map((tab) => {
        const web = tab.view.webContents;
        return {
          id: tab.id,
          threadId,
          title: web.getTitle() || "New tab",
          url: web.getURL() || "about:blank",
          loading: web.isLoading(),
          canGoBack: web.navigationHistory.canGoBack(),
          canGoForward: web.navigationHistory.canGoForward(),
          sharedWithAgent: true,
          ...(tab.error ? { error: tab.error } : {}),
        };
      });
  }

  #publish(threadId: string): void {
    const tabs = this.#workspaceSnapshot(threadId);
    for (const owner of this.#owners.values()) {
      if (
        !owner.window.isDestroyed() &&
        !owner.window.webContents.isDestroyed()
      )
        owner.window.webContents.send(ipcChannels.workspaceBrowserChanged, {
          threadId,
          tabs,
        });
    }
  }

  async #load(tab: Tab, url: string): Promise<void> {
    tab.error = undefined;
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      if (
        this.#tabs.get(tab.id) !== tab ||
        (error as NodeJS.ErrnoException).code === "ERR_ABORTED"
      )
        return;
      tab.error = error instanceof Error ? error.message : String(error);
      this.#publish(tab.threadId);
      throw error;
    }
  }

  #new(threadId: string, owner?: Owner): Tab {
    if (this.#tabs.size >= 20)
      throw new Error(
        "Close a browser tab before opening another (20 tab limit)",
      );
    const view = this.#dependencies.createView();
    const tab: Tab = {
      id: randomUUID(),
      threadId,
      view,
      owner,
      documentVersion: 0,
    };
    this.#tabs.set(tab.id, tab);
    view.setVisible(false);
    const web = view.webContents;
    web.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    web.session.setPermissionCheckHandler(() => false);
    const publish = () => this.#publish(threadId);
    web.on("page-title-updated", publish);
    web.on("did-navigate", publish);
    web.on("did-navigate-in-page", publish);
    web.on("did-start-loading", publish);
    web.on("did-stop-loading", publish);
    web.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        tab.documentVersion += 1;
        tab.observation = undefined;
      }
    });
    const guardNavigation = (event: Electron.Event, nextUrl: string) => {
      try {
        workspaceBrowserUrl(nextUrl);
      } catch {
        event.preventDefault();
        tab.error = "This address cannot open in the browser";
        publish();
      }
    };
    web.on("will-navigate", guardNavigation);
    web.on("will-redirect", guardNavigation);
    web.setWindowOpenHandler(({ url }) => {
      try {
        const safeUrl = workspaceBrowserUrl(url);
        const popup = this.#new(threadId, tab.owner);
        void this.#load(popup, safeUrl).catch(() => undefined);
        publish();
      } catch (error) {
        tab.error = error instanceof Error ? error.message : String(error);
        publish();
      }
      return { action: "deny" };
    });
    web.on("before-input-event", (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
        const currentOwner = tab.owner;
        if (currentOwner === undefined) return;
        event.preventDefault();
        currentOwner.window.webContents.focus();
        currentOwner.window.webContents.send(
          ipcChannels.workspaceBrowserFocusAddress,
          threadId,
        );
      }
    });
    web.on("render-process-gone", (_event, details) => {
      tab.error = `Page stopped (${details.reason}). Reload to retry.`;
      publish();
    });
    web.on("destroyed", () => {
      if (tab.owner?.active?.tab === tab) this.#hide(tab.owner);
      this.#tabs.delete(tab.id);
      void this.#artifacts.clearScope(tab.id);
      publish();
    });
    return tab;
  }

  command(
    sender: WebContents,
    threadId: unknown,
    command: unknown,
    tabId?: unknown,
    url?: unknown,
  ): WorkspaceBrowserTab[] {
    if (typeof threadId !== "string" || !threadId || threadId.length > 512)
      throw new Error("Invalid browser Thread");
    const owner = this.#owner(sender);
    if (command === "list") return this.#workspaceSnapshot(threadId);
    if (command === "new") {
      const safeUrl = workspaceBrowserUrl(url ?? "");
      const tab = this.#new(threadId, owner);
      void this.#load(tab, safeUrl).catch(() => undefined);
      this.#publish(threadId);
      return this.#workspaceSnapshot(threadId);
    }
    const tab = typeof tabId === "string" ? this.#tabs.get(tabId) : undefined;
    if (!tab || tab.threadId !== threadId)
      throw new Error("Browser tab is not in this Thread");
    const web = tab.view.webContents;
    switch (command) {
      case "navigate":
        void this.#load(tab, workspaceBrowserUrl(url)).catch(() => undefined);
        break;
      case "back":
        if (web.navigationHistory.canGoBack()) web.navigationHistory.goBack();
        break;
      case "forward":
        if (web.navigationHistory.canGoForward())
          web.navigationHistory.goForward();
        break;
      case "reload":
        tab.error = undefined;
        web.reload();
        break;
      case "close":
        this.#closeTab(tab);
        break;
      default:
        throw new Error("Unknown browser command");
    }
    this.#publish(threadId);
    return this.#workspaceSnapshot(threadId);
  }

  mount(sender: WebContents, request: unknown): void {
    if (!request || typeof request !== "object")
      throw new Error("Invalid browser view");
    const value = request as {
      threadId?: unknown;
      tabId?: unknown;
      lease?: unknown;
      bounds?: { x: number; y: number; width: number; height: number };
    };
    if (typeof value.lease !== "string" || value.lease.length > 100)
      throw new Error("Invalid browser view lease");
    const owner = this.#owner(sender);
    if (!value.bounds) {
      if (owner.active?.lease === value.lease) this.#hide(owner);
      return;
    }
    const tab =
      typeof value.tabId === "string" ? this.#tabs.get(value.tabId) : undefined;
    if (!tab || tab.threadId !== value.threadId)
      throw new Error("Browser tab is not in this Thread");
    const { x, y, width, height } = value.bounds;
    if (![x, y, width, height].every(Number.isFinite))
      throw new Error("Invalid browser bounds");
    const [windowWidth = 0, windowHeight = 0] = owner.window.getContentSize();
    const bounds = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: Math.max(
        0,
        Math.min(Math.round(width), windowWidth - Math.max(0, Math.round(x))),
      ),
      height: Math.max(
        0,
        Math.min(Math.round(height), windowHeight - Math.max(0, Math.round(y))),
      ),
    };
    if (!bounds.width || !bounds.height) {
      if (owner.active?.lease === value.lease) this.#hide(owner);
      return;
    }
    if (tab.owner !== undefined && tab.owner !== owner) this.#hide(tab.owner);
    tab.owner = owner;
    if (owner.active?.tab !== tab) {
      this.#hide(owner);
      owner.window.contentView.addChildView(tab.view);
    }
    owner.active = { tab, lease: value.lease };
    tab.view.setBounds(bounds);
    tab.view.setVisible(true);
  }

  observeTab(
    sessionId: string,
    tabId: string,
    listener: BrowserLiveObservationListener,
  ): () => void {
    const tab = this.#requireAgentTab(sessionId, tabId);
    return observeElectronPage(
      {
        capture: async () => await tab.view.webContents.capturePage(),
        current: () =>
          this.#tabs.get(tab.id) === tab && !tab.view.webContents.isDestroyed()
            ? tab.documentVersion
            : undefined,
      },
      listener,
    );
  }

  async listTabs(sessionId: string): Promise<BrowserTabSummary[]> {
    const threadId = this.#requireSessionThread(sessionId);
    return [...this.#tabs.values()]
      .filter(
        (tab) =>
          tab.threadId === threadId && !tab.view.webContents.isDestroyed(),
      )
      .map((tab) => this.#agentSummary(sessionId, tab));
  }

  async open(sessionId: string, url: string): Promise<BrowserTabSummary> {
    const threadId = this.#requireSessionThread(sessionId);
    const safeUrl = workspaceBrowserUrl(url);
    const tab = this.#new(threadId);
    try {
      await this.#load(tab, safeUrl);
      this.#publish(threadId);
      return this.#agentSummary(sessionId, tab);
    } catch (error) {
      this.#closeTab(tab);
      throw error;
    }
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    tab.observation = undefined;
    await this.#load(tab, workspaceBrowserUrl(url));
    return this.#agentSummary(sessionId, tab);
  }

  async inspect(sessionId: string, tabId: string): Promise<BrowserInspection> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    const documentVersion = tab.documentVersion;
    const inspected = await this.#evaluate<{
      visibleText: string;
      targets: BrowserTargetFingerprint[];
    }>(tab, browserInspectScript);
    const observationId = randomUUID();
    const image = await tab.view.webContents.capturePage();
    let png = image.toPNG();
    if (png.byteLength > 4 * 1024 * 1024) {
      const size = image.getSize();
      const scale = Math.sqrt((4 * 1024 * 1024) / png.byteLength);
      png = image
        .resize({
          width: Math.max(1, Math.floor(size.width * scale)),
          height: Math.max(1, Math.floor(size.height * scale)),
        })
        .toPNG();
    }
    const screenshot = await this.#artifacts.write(tab.id, observationId, png);
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
    const projected = inspected.targets.slice(0, 80).map((target) => {
      const targetId = randomUUID();
      targets.set(targetId, target);
      return {
        targetId,
        role: target.role,
        name: target.name,
        actions: [...target.actions],
        ...(target.value === undefined ? {} : { value: target.value }),
        ...(target.checked === undefined ? {} : { checked: target.checked }),
        ...(target.selected === undefined ? {} : { selected: target.selected }),
        ...(target.options === undefined
          ? {}
          : { options: target.options.map((option) => ({ ...option })) }),
        ...(target.optionsTruncated === undefined
          ? {}
          : { optionsTruncated: target.optionsTruncated }),
      };
    });
    tab.observation = { id: observationId, documentVersion, targets };
    return {
      ...this.#agentSummary(sessionId, tab),
      observationId,
      documentVersion,
      visibleText: inspected.visibleText.slice(0, 8_000),
      screenshot,
      targets: projected,
    };
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
  ): Promise<BrowserTabSummary> {
    return await this.#act(sessionId, tabId, observationId, targetId, "click");
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "type",
      text,
      submit,
    );
  }

  async select(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    option: string,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "select",
      option,
    );
  }

  async scroll(
    sessionId: string,
    tabId: string,
    observationId: string,
    direction: BrowserScrollDirection,
    pixels: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    signal?.throwIfAborted();
    const tab = this.#requireAgentTab(sessionId, tabId);
    assertBrowserObservation(
      tab.observation,
      tab.documentVersion,
      observationId,
    );
    tab.observation = undefined;
    await this.#evaluate(tab, browserScrollScript(direction, pixels));
    if (signal?.aborted)
      throw new Error(
        "Browser scroll outcome unknown after cancellation; inspect again before interacting",
      );
    return this.#agentSummary(sessionId, tab);
  }

  async closeTab(sessionId: string, tabId: string): Promise<void> {
    this.#closeTab(this.#requireAgentTab(sessionId, tabId));
  }

  closeSession(sessionId: string): number {
    this.#requireSessionThread(sessionId);
    this.#sessionThreads.delete(sessionId);
    return 0;
  }

  async close(): Promise<void> {
    this.#sessionThreads.clear();
  }

  async shutdown(): Promise<void> {
    for (const tab of [...this.#tabs.values()]) this.#closeTab(tab);
    await this.#artifacts.close();
  }

  async #act(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    action: BrowserTargetAction,
    value?: string,
    submit = false,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    const target = resolveBrowserObservedTarget(
      tab.observation,
      tab.documentVersion,
      observationId,
      targetId,
      action,
    );
    tab.observation = undefined;
    const result = await this.#evaluate<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, action, value, submit),
    );
    if (!result.ok)
      throw new Error(
        `Browser ${action} target is stale or unsafe: ${result.reason}`,
      );
    await settleWebContents(tab.view.webContents);
    return this.#agentSummary(sessionId, tab);
  }

  #requireSessionThread(sessionId: string): string {
    const threadId = this.#sessionThreads.get(sessionId);
    if (threadId === undefined)
      throw new Error("Browser session is not bound to a Thread");
    return threadId;
  }

  #requireAgentTab(sessionId: string, tabId: string): Tab {
    const threadId = this.#requireSessionThread(sessionId);
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.threadId !== threadId ||
      tab.view.webContents.isDestroyed()
    )
      throw new Error(`Unknown browser target ${sessionId}/${tabId}`);
    return tab;
  }

  #agentSummary(sessionId: string, tab: Tab): BrowserTabSummary {
    const web = tab.view.webContents;
    return {
      sessionId,
      tabId: tab.id,
      title: (web.getTitle() || "New tab").slice(0, 256),
      url: redactBrowserUrl(web.getURL() || "about:blank"),
      loading: web.isLoading(),
    };
  }

  #closeTab(tab: Tab): void {
    if (tab.owner?.active?.tab === tab) this.#hide(tab.owner);
    this.#tabs.delete(tab.id);
    tab.observation = undefined;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    void this.#artifacts.clearScope(tab.id);
    this.#publish(tab.threadId);
  }

  async #evaluate<T>(tab: Tab, expression: string): Promise<T> {
    const debuggerApi = tab.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const response = (await debuggerApi.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails !== undefined)
      throw new Error(
        `Browser CDP evaluation failed: ${response.exceptionDetails.text ?? response.result?.description ?? "unknown error"}`,
      );
    return response.result?.value as T;
  }
}

async function settleWebContents(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    webContents.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
