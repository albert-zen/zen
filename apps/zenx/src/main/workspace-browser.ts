import { randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView, type WebContents } from "electron";
import { ipcChannels } from "../preload/ipc.js";

export interface WorkspaceBrowserTab {
  id: string;
  threadId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}
export type WorkspaceBrowserCommand =
  "list" | "new" | "navigate" | "back" | "forward" | "reload" | "close";
interface Tab {
  id: string;
  threadId: string;
  view: WebContentsView;
  error?: string;
}
interface Owner {
  window: BrowserWindow;
  tabs: Map<string, Tab>;
  active?: { tab: Tab; lease: string };
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

// Human browsing is independent of Agent sessions/targets. Remote pages get no preload
// or Node access. Only the owning ZenX renderer can mount or control these views.
export class WorkspaceBrowser {
  #owners = new Map<number, Owner>();
  #owner(sender: WebContents): Owner {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.webContents !== sender)
      throw new Error("Browser UI requires its owning window");
    let owner = this.#owners.get(sender.id);
    if (!owner) {
      owner = { window, tabs: new Map() };
      this.#owners.set(sender.id, owner);
      const id = sender.id;
      window.once("closed", () => {
        for (const tab of owner!.tabs.values())
          if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
        this.#owners.delete(id);
      });
      sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) this.#hide(owner!);
      });
    }
    return owner;
  }
  #hide(owner: Owner) {
    if (owner.active) {
      owner.active.tab.view.setVisible(false);
      if (!owner.window.isDestroyed())
        owner.window.contentView.removeChildView(owner.active.tab.view);
      owner.active = undefined;
    }
  }
  #snapshot(owner: Owner, threadId: string): WorkspaceBrowserTab[] {
    return [...owner.tabs.values()]
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
          ...(tab.error ? { error: tab.error } : {}),
        };
      });
  }
  #publish(owner: Owner, threadId: string) {
    if (!owner.window.isDestroyed() && !owner.window.webContents.isDestroyed())
      owner.window.webContents.send(ipcChannels.workspaceBrowserChanged, {
        threadId,
        tabs: this.#snapshot(owner, threadId),
      });
  }
  #load(owner: Owner, tab: Tab, url: string) {
    tab.error = undefined;
    void tab.view.webContents.loadURL(url).catch((error) => {
      if (owner.tabs.get(tab.id) !== tab || error.code === "ERR_ABORTED")
        return;
      tab.error = error.message;
      this.#publish(owner, tab.threadId);
    });
  }
  #new(owner: Owner, threadId: string, url: string) {
    if (owner.tabs.size >= 20)
      throw new Error(
        "Close a browser tab before opening another (20 tab limit)",
      );
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:zenx-workspace-browser",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const tab: Tab = { id: randomUUID(), threadId, view };
    owner.tabs.set(tab.id, tab);
    view.setVisible(false);
    const web = view.webContents;
    web.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    web.session.setPermissionCheckHandler(() => false);
    const publish = () => this.#publish(owner, threadId);
    web.on("page-title-updated", publish);
    web.on("did-navigate", publish);
    web.on("did-navigate-in-page", publish);
    web.on("did-start-loading", publish);
    web.on("did-stop-loading", publish);
    const guardNavigation = (event: Electron.Event, url: string) => {
      try {
        workspaceBrowserUrl(url);
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
        this.#new(owner, threadId, workspaceBrowserUrl(url));
      } catch (error) {
        tab.error = String(error);
        publish();
      }
      return { action: "deny" };
    });
    web.on("before-input-event", (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
        event.preventDefault();
        owner.window.webContents.focus();
        owner.window.webContents.send(
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
      if (owner.active?.tab === tab) this.#hide(owner);
      owner.tabs.delete(tab.id);
      publish();
    });
    this.#load(owner, tab, url);
    publish();
    return tab;
  }
  command(
    sender: WebContents,
    threadId: unknown,
    command: unknown,
    tabId?: unknown,
    url?: unknown,
  ) {
    if (typeof threadId !== "string" || !threadId || threadId.length > 512)
      throw new Error("Invalid browser Thread");
    const owner = this.#owner(sender);
    if (command === "list") return this.#snapshot(owner, threadId);
    if (command === "new") {
      this.#new(owner, threadId, workspaceBrowserUrl(url ?? ""));
      return this.#snapshot(owner, threadId);
    }
    const tab = typeof tabId === "string" ? owner.tabs.get(tabId) : undefined;
    if (!tab || tab.threadId !== threadId)
      throw new Error("Browser tab is not in this Thread");
    const web = tab.view.webContents;
    switch (command) {
      case "navigate":
        this.#load(owner, tab, workspaceBrowserUrl(url));
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
        if (owner.active?.tab === tab) this.#hide(owner);
        owner.tabs.delete(tab.id);
        web.close();
        break;
      default:
        throw new Error("Unknown browser command");
    }
    this.#publish(owner, threadId);
    return this.#snapshot(owner, threadId);
  }
  mount(sender: WebContents, request: unknown) {
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
      typeof value.tabId === "string" ? owner.tabs.get(value.tabId) : undefined;
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
    if (owner.active?.tab !== tab) {
      this.#hide(owner);
      owner.window.contentView.addChildView(tab.view);
    }
    owner.active = { tab, lease: value.lease };
    tab.view.setBounds(bounds);
    tab.view.setVisible(true);
  }
}
