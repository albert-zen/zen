import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents, WebContentsView } from "electron";

import { ipcChannels } from "../preload/ipc.js";
import { observeElectronPage } from "./capabilities/browser-electron-observation.js";
import {
  assertBrowserObservation,
  browserActionScript,
  browserInspectScript,
  browserDomCapture,
  evaluateBrowserDocument,
  type BrowserDomInspection,
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

import {
  OBSERVATION_CAPTURE,
  MAX_OBSERVATION_CAPTURE_ITEMS,
} from "./capabilities/observation-capture.js";

export interface WorkspaceBrowserTab {
  id: string;
  threadId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  sharedWithAgent: true;
  control: "agent" | "human";
  agentActionsInFlight: number;
  agentActionOutcomeUnknown: boolean;
  requiresFreshObservation: boolean;
  error?: string;
}
export type WorkspaceBrowserCommand =
  | "list"
  | "new"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "close"
  | "take-control"
  | "return-control";

interface Tab {
  id: string;
  threadId: string;
  view: WebContentsView;
  owner?: Owner;
  control: "agent" | "human";
  controlRevision: number;
  handoffMode: boolean;
  agentActionsInFlight: number;
  agentActionOutcomeUnknown: boolean;
  documentVersion: number;
  navigationGeneration: number;
  renderRevision: number;
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
  renderWhileUnmounted?<T>(
    view: WebContentsView,
    isMounted: () => boolean,
    operation: () => Promise<T>,
  ): Promise<T>;
  releaseUnmountedView?(view: WebContentsView): void;
  closeUnmountedRenderer?(): void;
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
  readonly #sessionIncarnations = new Map<string, string>();
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
      ...(options.dependencies.renderWhileUnmounted === undefined
        ? {}
        : { renderWhileUnmounted: options.dependencies.renderWhileUnmounted }),
      ...(options.dependencies.releaseUnmountedView === undefined
        ? {}
        : { releaseUnmountedView: options.dependencies.releaseUnmountedView }),
      ...(options.dependencies.closeUnmountedRenderer === undefined
        ? {}
        : {
            closeUnmountedRenderer: options.dependencies.closeUnmountedRenderer,
          }),
    };
  }

  bindThreadSession(sessionId: string, threadId: string): void {
    const existing = this.#sessionThreads.get(sessionId);
    if (existing !== undefined && existing !== threadId)
      throw new Error("Browser session is already bound to another Thread");
    this.#sessionThreads.set(sessionId, threadId);
    if (existing === undefined)
      this.#sessionIncarnations.set(sessionId, randomUUID());
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
    owner.active.tab.renderRevision += 1;
    owner.active.tab.observation = undefined;
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
          ...this.#controlSummary(tab),
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
    const generation = this.#beginNavigation(tab);
    tab.error = undefined;
    const web = tab.view.webContents;
    // Electron 43 loadURL can resolve on an older document's late finish event.
    // Keep the existing generation fence, but also require this request's
    // main-frame commit and completion (redirects may change the final URL).
    let started = false;
    let sameDocument = false;
    let committed = false;
    let completed = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A synchronous loadURL throw must not leave a rejected side promise unhandled.
    void completion.catch(() => undefined);
    const current = () => {
      try {
        this.#assertNavigationCurrent(tab, generation);
        return true;
      } catch (error) {
        rejectCompletion(error);
        return false;
      }
    };
    const start = (
      _event: Electron.Event,
      _url: string,
      inPage: boolean,
      main: boolean,
    ) => {
      if (!main || !current()) return;
      if (started && !inPage) {
        rejectCompletion(
          new Error(
            "Browser navigation was interrupted by another page request",
          ),
        );
        return;
      }
      if (!started) sameDocument = inPage;
      started = true;
    };
    const commit = () => {
      if (started && current()) committed = true;
    };
    const finish = () => {
      if (!committed || !current()) return;
      completed = true;
      resolveCompletion();
    };
    const inPage = (_event: Electron.Event, _url: string, main: boolean) => {
      if (main && started && sameDocument && current()) {
        committed = true;
        finish();
      }
    };
    const stop = () => {
      if (started && !completed && !web.isLoading() && current())
        rejectCompletion(
          new Error("Browser navigation stopped before its document completed"),
        );
    };
    const destroyed = () =>
      rejectCompletion(new Error("Browser navigation target was closed"));
    web.on("did-start-navigation", start);
    web.on("did-navigate", commit);
    web.on("did-navigate-in-page", inPage);
    web.on("did-finish-load", finish);
    web.on("did-stop-loading", stop);
    web.on("destroyed", destroyed);
    try {
      await Promise.all([web.loadURL(url), completion]);
    } catch (error) {
      this.#assertNavigationCurrent(tab, generation);
      if ((error as NodeJS.ErrnoException).code === "ERR_ABORTED") {
        tab.error =
          "Navigation was interrupted. Inspect the current page before continuing.";
        this.#publish(tab.threadId);
        throw new Error(tab.error, { cause: error });
      }
      tab.error = error instanceof Error ? error.message : String(error);
      this.#publish(tab.threadId);
      throw error;
    } finally {
      web.removeListener("did-start-navigation", start);
      web.removeListener("did-navigate", commit);
      web.removeListener("did-navigate-in-page", inPage);
      web.removeListener("did-finish-load", finish);
      web.removeListener("did-stop-loading", stop);
      web.removeListener("destroyed", destroyed);
    }
    this.#assertNavigationCurrent(tab, generation);
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
      control: "agent",
      controlRevision: 0,
      handoffMode: false,
      agentActionsInFlight: 0,
      agentActionOutcomeUnknown: false,
      documentVersion: 0,
      navigationGeneration: 0,
      renderRevision: 0,
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
    web.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
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
      case "take-control":
      case "return-control": {
        const control = command === "take-control" ? "human" : "agent";
        if (tab.control !== control) {
          tab.control = control;
          tab.handoffMode = true;
          tab.controlRevision += 1;
          tab.renderRevision += 1;
          tab.observation = undefined;
        }
        break;
      }
      case "navigate":
        void this.#load(tab, workspaceBrowserUrl(url)).catch(() => undefined);
        break;
      case "back":
        if (web.navigationHistory.canGoBack()) {
          this.#beginNavigation(tab);
          web.navigationHistory.goBack();
        }
        break;
      case "forward":
        if (web.navigationHistory.canGoForward()) {
          this.#beginNavigation(tab);
          web.navigationHistory.goForward();
        }
        break;
      case "reload":
        tab.error = undefined;
        this.#beginNavigation(tab);
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
    const previousBounds = tab.view.getBounds();
    const changedMount =
      owner.active?.tab !== tab ||
      owner.active.lease !== value.lease ||
      previousBounds.x !== bounds.x ||
      previousBounds.y !== bounds.y ||
      previousBounds.width !== bounds.width ||
      previousBounds.height !== bounds.height;
    if (tab.owner !== undefined && tab.owner !== owner) this.#hide(tab.owner);
    tab.owner = owner;
    if (owner.active?.tab !== tab) {
      this.#hide(owner);
      this.#dependencies.releaseUnmountedView?.(tab.view);
      owner.window.contentView.addChildView(tab.view);
    }
    if (changedMount) {
      tab.renderRevision += 1;
      tab.observation = undefined;
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
        capture: async () =>
          await this.#rendered(tab, async () => {
            this.#requireAgentTab(sessionId, tabId);
            return await tab.view.webContents.capturePage();
          }),
        current: () =>
          this.#sessionThreads.get(sessionId) === tab.threadId &&
          this.#tabs.get(tab.id) === tab &&
          !tab.view.webContents.isDestroyed()
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

  async open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const threadId = this.#requireSessionThread(sessionId);
    const safeUrl = workspaceBrowserUrl(url);
    const tab = this.#new(threadId);
    try {
      await this.#mutate(
        sessionId,
        tab,
        undefined,
        signal,
        async (dispatch) => {
          dispatch();
          await this.#load(tab, safeUrl);
        },
      );
      this.#publish(threadId);
      return this.#agentSummary(
        sessionId,
        this.#requireAgentTab(sessionId, tab.id),
      );
    } catch (error) {
      if (!tab.handoffMode) this.#closeTab(tab);
      throw error;
    }
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
    observationId?: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    const safeUrl = workspaceBrowserUrl(url);
    await this.#mutate(
      sessionId,
      tab,
      observationId,
      signal,
      async (dispatch) => {
        dispatch();
        await this.#load(tab, safeUrl);
        return this.#agentSummary(
          sessionId,
          this.#requireAgentTab(sessionId, tabId),
        );
      },
    );
    return this.#agentSummary(sessionId, tab);
  }

  async inspect(sessionId: string, tabId: string): Promise<BrowserInspection> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    const controlRevision = tab.controlRevision;
    return await this.#rendered(tab, async () => {
      this.#assertControlRevision(tab, controlRevision);
      this.#requireAgentTab(sessionId, tabId);
      const documentVersion = tab.documentVersion;
      const sessionIncarnation = this.#sessionIncarnations.get(sessionId);
      const navigationGeneration = tab.navigationGeneration;
      const renderRevision = tab.renderRevision;
      const inspected = await this.#evaluate<BrowserDomInspection>(
        tab,
        browserInspectScript,
      );
      this.#assertAgentOperationCurrent(
        sessionId,
        tab,
        navigationGeneration,
        documentVersion,
        "inspection",
        renderRevision,
      );
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
      this.#assertAgentOperationCurrent(
        sessionId,
        tab,
        navigationGeneration,
        documentVersion,
        "inspection",
        renderRevision,
      );
      const screenshot = await this.#artifacts.write(
        tab.id,
        observationId,
        png,
      );
      try {
        this.#assertAgentOperationCurrent(
          sessionId,
          tab,
          navigationGeneration,
          documentVersion,
          "inspection",
          renderRevision,
        );
      } catch (error) {
        await this.#artifacts.removeArtifact(
          screenshot.artifactPath,
          screenshot.observationId,
        );
        throw error;
      }
      const targets = new Map<string, BrowserTargetFingerprint>();
      const projected = inspected.targets
        .slice(0, MAX_OBSERVATION_CAPTURE_ITEMS)
        .map((target) => {
          const targetId = randomUUID();
          targets.set(targetId, target);
          return {
            targetId,
            role: target.role,
            name: target.name,
            actions: [...target.actions],
            ...(target.value === undefined ? {} : { value: target.value }),
            ...(target.checked === undefined
              ? {}
              : { checked: target.checked }),
            ...(target.selected === undefined
              ? {}
              : { selected: target.selected }),
            ...(target.options === undefined
              ? {}
              : { options: target.options.map((option) => ({ ...option })) }),
            ...(target.optionsTruncated === undefined
              ? {}
              : { optionsTruncated: target.optionsTruncated }),
          };
        });
      tab.observation =
        tab.handoffMode && tab.agentActionsInFlight > 0
          ? undefined
          : {
              id: observationId,
              documentVersion,
              targets,
              ...(inspected.documentIdentity === undefined
                ? {}
                : { documentIdentity: inspected.documentIdentity }),
            };
      if (tab.control === "agent" && tab.agentActionsInFlight === 0) {
        tab.agentActionOutcomeUnknown = false;
      }
      this.#publish(tab.threadId);
      return {
        ...this.#agentSummary(sessionId, tab),
        observationId,
        documentVersion,
        visibleText: inspected.visibleText.slice(0, 8_000),
        screenshot,
        targets: projected.slice(0, 80),
        [OBSERVATION_CAPTURE]: {
          ...browserDomCapture(
            inspected,
            projected,
            `${sessionId}/${sessionIncarnation}/${tab.id}`,
          ),
          assertCurrent: () => {
            this.#assertAgentOperationCurrent(
              sessionId,
              tab,
              navigationGeneration,
              documentVersion,
              "observation continuation",
              renderRevision,
            );
            if (
              tab.observation?.id !== observationId ||
              this.#sessionIncarnations.get(sessionId) !== sessionIncarnation
            )
              throw new Error(
                "Browser observation capture is stale; inspect again",
              );
          },
        },
      };
    });
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "click",
      undefined,
      false,
      signal,
    );
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "type",
      text,
      submit,
      signal,
    );
  }

  async select(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "select",
      option,
      false,
      signal,
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
    await this.#mutate(
      sessionId,
      tab,
      observationId,
      signal,
      async (dispatch) =>
        this.#rendered(tab, async () => {
          signal?.throwIfAborted();
          this.#requireAgentTab(sessionId, tabId);
          const navigationGeneration = tab.navigationGeneration;
          const documentVersion = tab.documentVersion;
          const renderRevision = tab.renderRevision;
          assertBrowserObservation(
            tab.observation,
            tab.documentVersion,
            observationId,
          );
          if (tab.observation.documentIdentity === undefined)
            throw new Error(
              "Browser document identity is unavailable; inspect again",
            );
          const expression = browserScrollScript(
            direction,
            pixels,
            tab.observation.documentIdentity,
          );
          tab.observation = undefined;
          await this.#evaluate(tab, expression, dispatch);
          this.#assertAgentOperationCurrent(
            sessionId,
            tab,
            navigationGeneration,
            documentVersion,
            "scroll",
            renderRevision,
          );
          if (signal?.aborted)
            throw new Error(
              "Browser scroll outcome unknown after cancellation; inspect again before interacting",
            );
          return this.#agentSummary(sessionId, tab);
        }),
    );
    return this.#agentSummary(sessionId, tab);
  }

  async closeTab(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
    observationId?: string,
  ): Promise<void> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    await this.#mutate(
      sessionId,
      tab,
      observationId,
      signal,
      async (dispatch) => {
        dispatch();
        this.#closeTab(tab);
      },
    );
  }

  closeSession(sessionId: string): number {
    this.#requireSessionThread(sessionId);
    this.#sessionThreads.delete(sessionId);
    this.#sessionIncarnations.delete(sessionId);
    return 0;
  }

  async close(): Promise<void> {
    this.#sessionThreads.clear();
    this.#sessionIncarnations.clear();
  }

  async shutdown(): Promise<void> {
    for (const tab of [...this.#tabs.values()]) this.#closeTab(tab);
    this.#dependencies.closeUnmountedRenderer?.();
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
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireAgentTab(sessionId, tabId);
    await this.#mutate(
      sessionId,
      tab,
      observationId,
      signal,
      async (dispatch) =>
        this.#rendered(tab, async () => {
          this.#requireAgentTab(sessionId, tabId);
          const navigationGeneration = tab.navigationGeneration;
          const renderRevision = tab.renderRevision;
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
            dispatch,
          );
          if (!result.ok)
            throw new Error(
              `Browser ${action} target is stale or unsafe: ${result.reason}`,
            );
          this.#assertAgentOperationCurrent(
            sessionId,
            tab,
            navigationGeneration,
            undefined,
            action,
            renderRevision,
          );
          await settleWebContents(tab.view.webContents);
          this.#assertAgentOperationCurrent(
            sessionId,
            tab,
            navigationGeneration,
            undefined,
            action,
            renderRevision,
          );
          return this.#agentSummary(sessionId, tab);
        }),
    );
    return this.#agentSummary(sessionId, tab);
  }

  #controlSummary(tab: Tab) {
    return {
      control: tab.control,
      agentActionsInFlight: tab.agentActionsInFlight,
      agentActionOutcomeUnknown: tab.agentActionOutcomeUnknown,
      requiresFreshObservation:
        tab.handoffMode &&
        (tab.control === "human" ||
          tab.observation === undefined ||
          tab.agentActionsInFlight > 0),
      ...(tab.handoffMode
        ? { mutationsRequireObservation: true as const }
        : {}),
    };
  }

  #assertControlRevision(tab: Tab, revision: number): void {
    if (tab.controlRevision !== revision)
      throw new Error(
        "Browser control changed; this request is stale. Inspect again; do not replay it automatically",
      );
  }

  async #mutate<T>(
    sessionId: string,
    tab: Tab,
    observationId: string | undefined,
    signal: AbortSignal | undefined,
    operation: (dispatch: () => void) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (tab.control === "human")
      throw new Error(
        "Browser tab is under human control; Agent mutations are paused until the user returns control",
      );
    if (tab.handoffMode) {
      if (tab.agentActionsInFlight > 0)
        throw new Error(
          "An earlier Browser action is still in flight; wait for its outcome and inspect again",
        );
      if (observationId === undefined || tab.observation === undefined)
        throw new Error(
          "Browser handoff requires a fresh observationId from browser_inspect before every mutation, including navigate and close",
        );
      assertBrowserObservation(
        tab.observation,
        tab.documentVersion,
        observationId,
      );
    }
    const revision = tab.controlRevision;
    const sessionIncarnation = this.#sessionIncarnations.get(sessionId);
    const admittedObservation = tab.observation;
    let dispatched = false;
    const dispatch = () => {
      signal?.throwIfAborted();
      this.#requireAgentTab(sessionId, tab.id);
      this.#assertControlRevision(tab, revision);
      if (this.#sessionIncarnations.get(sessionId) !== sessionIncarnation)
        throw new Error(
          "Browser session changed before dispatch; inspect again",
        );
      if (
        tab.observation !== undefined &&
        tab.observation !== admittedObservation
      )
        throw new Error(
          "Browser request is stale after a newer observation; inspect again",
        );
      tab.observation = undefined;
      if (!dispatched) {
        dispatched = true;
        tab.agentActionsInFlight += 1;
        this.#publish(tab.threadId);
      }
    };
    try {
      const result = await operation(dispatch);
      if (
        dispatched &&
        (tab.controlRevision !== revision ||
          this.#sessionIncarnations.get(sessionId) !== sessionIncarnation ||
          signal?.aborted)
      )
        throw new Error(
          "Browser action outcome is unknown after control changed or cancellation; it was already dispatched. Inspect before continuing; do not repeat it automatically",
        );
      return result;
    } catch (error) {
      if (dispatched) {
        tab.agentActionOutcomeUnknown = true;
        tab.observation = undefined;
        // Dispatch is irreversible here. A failed CDP reply is not proof that
        // the page action was cancelled or had no effect.
        throw new Error(
          `Browser action outcome is unknown after dispatch: ${error instanceof Error ? error.message : String(error)}. Inspect before continuing; do not repeat it automatically`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (dispatched) tab.agentActionsInFlight -= 1;
      this.#publish(tab.threadId);
    }
  }

  async #rendered<T>(tab: Tab, operation: () => Promise<T>): Promise<T> {
    if (this.#dependencies.renderWhileUnmounted === undefined) {
      return await operation();
    }
    return await this.#dependencies.renderWhileUnmounted(
      tab.view,
      () => tab.owner?.active?.tab === tab,
      operation,
    );
  }

  #beginNavigation(tab: Tab): number {
    tab.observation = undefined;
    tab.navigationGeneration += 1;
    return tab.navigationGeneration;
  }

  #assertNavigationCurrent(tab: Tab, generation: number): void {
    if (this.#tabs.get(tab.id) !== tab || tab.view.webContents.isDestroyed())
      throw new Error(
        "Unknown browser navigation target; it is no longer available",
      );
    if (tab.navigationGeneration !== generation)
      throw new Error(
        "Browser navigation was superseded by a newer page request",
      );
  }

  #assertAgentOperationCurrent(
    sessionId: string,
    tab: Tab,
    navigationGeneration: number,
    documentVersion: number | undefined,
    operation: string,
    renderRevision?: number,
  ): void {
    this.#requireAgentTab(sessionId, tab.id);
    if (
      tab.navigationGeneration !== navigationGeneration ||
      (documentVersion !== undefined &&
        tab.documentVersion !== documentVersion) ||
      (renderRevision !== undefined && tab.renderRevision !== renderRevision)
    )
      throw new Error(
        `Browser ${operation} became stale and its outcome is unknown after the page changed; inspect again`,
      );
  }

  #requireSessionThread(sessionId: string): string {
    const threadId = this.#sessionThreads.get(sessionId);
    if (threadId === undefined)
      throw new Error("Browser session is not bound to a Thread");
    return threadId;
  }

  #requireAgentTab(sessionId: string, tabId: string): Tab {
    const threadId = this.#sessionThreads.get(sessionId);
    const tab = this.#tabs.get(tabId);
    if (
      threadId === undefined ||
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
      ...this.#controlSummary(tab),
    };
  }

  #closeTab(tab: Tab): void {
    this.#dependencies.releaseUnmountedView?.(tab.view);
    if (tab.owner?.active?.tab === tab) this.#hide(tab.owner);
    this.#tabs.delete(tab.id);
    tab.observation = undefined;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    void this.#artifacts.clearScope(tab.id);
    this.#publish(tab.threadId);
  }

  async #evaluate<T>(
    tab: Tab,
    expression: string,
    beforeDispatch?: () => void,
  ): Promise<T> {
    const debuggerApi = tab.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    return await evaluateBrowserDocument<T>(
      debuggerApi,
      expression,
      beforeDispatch,
    );
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
