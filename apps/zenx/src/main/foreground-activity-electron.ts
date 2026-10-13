import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Display,
  IpcMain,
  IpcMainEvent,
  Screen,
} from "electron";
import {
  foregroundActivityHtml,
  foregroundActivityText,
} from "../foreground-activity-view.js";
import type { SupportedLanguage } from "../locale.js";
import type {
  ForegroundActivityPresenter,
  ForegroundActivitySnapshot,
} from "./foreground-activity.js";

export const foregroundActivityChannels = {
  render: "zenx:foreground-activity:render",
  painted: "zenx:foreground-activity:painted",
  stop: "zenx:foreground-activity:stop",
} as const;

type Overlay = {
  window: BrowserWindow;
  kind: "edges" | "status";
  displayId: number;
  url: string;
  /** Activity IDs never reappear after settlement; compress their contiguous
   * display history instead of retaining an unbounded list of render snapshots. */
  owners: Map<string, { firstVersion: number; lastVersion: number }>;
  firstSentVersion: number | undefined;
  sentVersion: number;
  paintedVersion: number;
  pending?: { version: number; resolve(): void; reject(error: Error): void };
};

export function foregroundOverlayBounds(
  display: Pick<Display, "bounds" | "workArea">,
  kind: "edges" | "status",
) {
  if (kind === "edges") return { ...display.bounds };
  const width = Math.min(480, display.bounds.width);
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: Math.max(display.bounds.y, display.workArea.y) + 8,
    width,
    height: 64,
  };
}

export function trustedForegroundSender(
  overlay: {
    window: Pick<BrowserWindow, "isDestroyed" | "webContents">;
    url: string;
  },
  event: Pick<IpcMainEvent, "sender" | "senderFrame">,
): boolean {
  return (
    !overlay.window.isDestroyed() &&
    event.sender === overlay.window.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === overlay.url
  );
}

/** Native UI resources only. No renderer can publish activity or grant consent. */
interface ElectronForegroundActivityOptions {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  screen: Pick<Screen, "getAllDisplays" | "on" | "removeListener">;
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  preloadPath: string;
  language(): SupportedLanguage;
  onStop(ids: readonly string[]): void;
  onUnavailable(error: unknown): void;
  platform?: string;
}

export class ElectronForegroundActivityPresenter implements ForegroundActivityPresenter {
  readonly #options: ElectronForegroundActivityOptions;
  readonly #overlays = new Map<string, Overlay>();
  #snapshot: ForegroundActivitySnapshot = { activities: [] };
  #tail: Promise<void> = Promise.resolve();
  #version = 0;
  #closed = false;
  #failure: Error | undefined;

  constructor(options: ElectronForegroundActivityOptions) {
    this.#options = options;
    options.ipcMain.on(foregroundActivityChannels.painted, this.#painted);
    options.ipcMain.on(foregroundActivityChannels.stop, this.#stop);
    options.screen.on("display-added", this.#displaysChanged);
    options.screen.on("display-removed", this.#displaysChanged);
    options.screen.on("display-metrics-changed", this.#displaysChanged);
  }

  update(snapshot: ForegroundActivitySnapshot): Promise<void> {
    this.#snapshot = snapshot;
    const work = this.#tail.then(() => this.#render());
    this.#tail = work.catch(() => undefined);
    return work;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.ipcMain.removeListener(
      foregroundActivityChannels.painted,
      this.#painted,
    );
    this.#options.ipcMain.removeListener(
      foregroundActivityChannels.stop,
      this.#stop,
    );
    this.#options.screen.removeListener("display-added", this.#displaysChanged);
    this.#options.screen.removeListener(
      "display-removed",
      this.#displaysChanged,
    );
    this.#options.screen.removeListener(
      "display-metrics-changed",
      this.#displaysChanged,
    );
    this.#dispose();
  }

  #displaysChanged = (): void => {
    if (this.#snapshot.activities.length === 0 || this.#closed) return;
    // Synchronously revoke every current foreground signal before an older
    // pending paint ACK can admit input. Repaint only the stopping projection;
    // a later explicit invocation must await indicators for the new displays.
    this.#options.onUnavailable(
      new Error("Displays changed; cancelling foreground computer input"),
    );
    void this.update(this.#snapshot).catch((error: unknown) =>
      this.#fail(error),
    );
  };

  #painted = (event: IpcMainEvent, version: unknown): void => {
    if (!Number.isSafeInteger(version)) return;
    for (const overlay of this.#overlays.values()) {
      const pending = overlay.pending;
      if (
        !pending ||
        !trustedForegroundSender(overlay, event) ||
        !overlay.window.isVisible() ||
        pending.version !== version
      )
        continue;
      overlay.paintedVersion = pending.version;
      pending.resolve();
    }
  };

  #stop = (event: IpcMainEvent, version: unknown): void => {
    for (const overlay of this.#overlays.values()) {
      if (
        overlay.kind !== "status" ||
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        overlay.firstSentVersion === undefined ||
        version < overlay.firstSentVersion ||
        version > overlay.sentVersion ||
        !trustedForegroundSender(overlay, event)
      )
        continue;
      const ids = [...overlay.owners]
        .filter(
          ([, owner]) =>
            version >= owner.firstVersion && version <= owner.lastVersion,
        )
        .map(([id]) => id);
      if (ids.length > 0) this.#options.onStop(ids);
      return;
    }
  };

  async #render(): Promise<void> {
    if (this.#closed) throw new Error("Foreground indicator is closed");
    const snapshot = this.#snapshot;
    if (snapshot.activities.length === 0) {
      this.#dispose();
      this.#failure = undefined;
      return;
    }
    if (this.#failure) throw this.#failure;
    if (
      (this.#options.platform ?? process.platform) === "linux" &&
      process.env.XDG_SESSION_TYPE === "wayland"
    ) {
      throw new Error(
        "Foreground control needs a supported non-activating overlay; Electron cannot guarantee positioning and always-on-top on Wayland",
      );
    }
    const paint: Promise<void>[] = [];
    try {
      const displays = this.#options.screen.getAllDisplays();
      if (displays.length === 0)
        throw new Error("Foreground indicator has no connected display");
      const current = new Set(displays.map((display) => display.id));
      for (const [key, overlay] of this.#overlays) {
        if (!current.has(overlay.displayId)) this.#remove(key, overlay);
      }
      const version = ++this.#version;
      for (const display of displays) {
        for (const kind of ["edges", "status"] as const) {
          const key = `${display.id}:${kind}`;
          let overlay = this.#overlays.get(key);
          if (!overlay) {
            overlay = this.#create(display, kind, snapshot);
            this.#overlays.set(key, overlay);
          }
          overlay.window.setBounds(foregroundOverlayBounds(display, kind));
          paint.push(this.#show(overlay, snapshot, version));
        }
      }
      await Promise.all(paint);
    } catch (error) {
      this.#fail(error);
      await Promise.allSettled(paint);
      throw error;
    }
  }

  #create(
    display: Display,
    kind: "edges" | "status",
    snapshot: ForegroundActivitySnapshot,
  ): Overlay {
    const window = this.#options.createWindow({
      ...foregroundOverlayBounds(display, kind),
      title: "ZenX foreground activity",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      focusable: false,
      acceptFirstMouse: kind === "status",
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: this.#options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    try {
      window.setIgnoreMouseEvents(kind === "edges");
      window.setAlwaysOnTop(true, "screen-saver");
      if ((this.#options.platform ?? process.platform) === "darwin") {
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        window.setHiddenInMissionControl(true);
      }
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      const html = foregroundActivityHtml({
        kind,
        agentNames: snapshot.activities.map((activity) => activity.agentName),
        stopping: snapshot.activities.every((activity) => activity.stopping),
        language: this.#options.language(),
      });
      const overlay: Overlay = {
        window,
        kind,
        displayId: display.id,
        url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        owners: new Map(),
        firstSentVersion: undefined,
        sentVersion: 0,
        paintedVersion: 0,
      };
      window.webContents.once("render-process-gone", () =>
        this.#unexpectedLoss(overlay),
      );
      window.once("closed", () => this.#unexpectedLoss(overlay));
      window.on("hide", () => this.#unexpectedLoss(overlay));
      window.on("minimize", () => this.#unexpectedLoss(overlay));
      return overlay;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  async #show(
    overlay: Overlay,
    snapshot: ForegroundActivitySnapshot,
    version: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Foreground indicator did not become visible before input",
            ),
          ),
        5_000,
      );
      const finish = (error?: Error): void => {
        if (overlay.pending?.version !== version) return;
        overlay.pending = undefined;
        clearTimeout(timer);
        if (error) reject(error);
        else {
          resolve();
        }
      };
      overlay.pending = { version, resolve: () => finish(), reject: finish };
      const show = () => {
        try {
          if (this.#closed || overlay.window.isDestroyed())
            return finish(new Error("Foreground indicator was closed"));
          overlay.window.showInactive();
          if (!overlay.window.isVisible())
            throw new Error("Foreground indicator is not visible");
          const currentIds = new Set(
            snapshot.activities.map((activity) => activity.id),
          );
          for (const id of overlay.owners.keys()) {
            if (!currentIds.has(id)) overlay.owners.delete(id);
          }
          for (const id of currentIds) {
            const owner = overlay.owners.get(id);
            if (owner) owner.lastVersion = version;
            else
              overlay.owners.set(id, {
                firstVersion: version,
                lastVersion: version,
              });
          }
          overlay.firstSentVersion ??= version;
          overlay.sentVersion = version;
          overlay.window.webContents.send(foregroundActivityChannels.render, {
            version,
            ...foregroundActivityText({
              agentNames: snapshot.activities.map(
                (activity) => activity.agentName,
              ),
              stopping: snapshot.activities.every(
                (activity) => activity.stopping,
              ),
              language: this.#options.language(),
            }),
            stopping: snapshot.activities.every(
              (activity) => activity.stopping,
            ),
          });
        } catch (error) {
          finish(asError(error));
        }
      };
      if (overlay.window.webContents.getURL() === overlay.url) show();
      else
        void overlay.window
          .loadURL(overlay.url)
          .then(show)
          .catch((error: unknown) => finish(asError(error)));
    });
  }

  #unexpectedLoss(overlay: Overlay): void {
    if (![...this.#overlays.values()].includes(overlay)) return;
    this.#fail(
      new Error("Foreground indicator was lost; cancelling foreground input"),
    );
  }

  #fail(error: unknown): void {
    if (this.#failure || this.#closed) return;
    this.#failure = asError(error);
    this.#dispose();
    this.#options.onUnavailable(this.#failure);
  }

  #remove(key: string, overlay: Overlay): void {
    this.#overlays.delete(key);
    overlay.pending?.reject(new Error("Foreground display was removed"));
    if (!overlay.window.isDestroyed()) overlay.window.destroy();
  }

  #dispose(): void {
    for (const [key, overlay] of this.#overlays) this.#remove(key, overlay);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
