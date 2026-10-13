import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
  WebContentsView,
} from "electron";

/** An ephemeral witness of the existing Workspace mount, never new authority. */
export interface WorkspaceBrowserRenderMount {
  window: BrowserWindow;
  isCurrent(): boolean;
  invalidate(): void;
}
interface RenderLease {
  window: BrowserWindow;
  released: boolean;
  attached: boolean;
  mount?: WorkspaceBrowserRenderMount;
  bounds: Electron.Rectangle;
  visible: boolean;
  failure?: unknown;
  interrupt(): void;
}

/** Lends an unavailable shared view a non-activating compositor surface. */
export class WorkspaceBrowserRenderer {
  readonly #active = new Map<WebContentsView, RenderLease>();
  readonly #tails = new Map<WebContentsView, Promise<void>>();
  #closed = false;

  constructor(
    readonly createWindow: (
      options: BrowserWindowConstructorOptions,
    ) => BrowserWindow,
  ) {}

  async render<T>(
    view: WebContentsView,
    currentMount: () => WorkspaceBrowserRenderMount | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#tails.get(view) ?? Promise.resolve();
    const result = prior.then(async () => {
      if (this.#closed || view.webContents.isDestroyed())
        throw new Error("Browser tab closed before rendering");
      const mount = currentMount();
      if (mount && (mount.window.isDestroyed() || !mount.isCurrent()))
        throw new Error(
          "Browser mount changed before rendering; inspect again",
        );
      if (mount && mount.window.isVisible() && !mount.window.isMinimized())
        return await operation();
      if (mount && !mount.window.contentView.children.includes(view))
        throw new Error("Browser view is not attached to its mount owner");

      const bounds = view.getBounds();
      const width = mount ? bounds.width : 1280;
      const height = mount ? bounds.height : 800;
      if (width <= 0 || height <= 0)
        throw new Error(
          "Browser viewport is unavailable for background rendering",
        );
      const window = this.createWindow({
        width,
        height,
        x: -10000,
        y: -10000,
        show: false,
        focusable: false,
        skipTaskbar: true,
        opacity: 0,
      });
      const lease: RenderLease = {
        window,
        released: false,
        attached: false,
        mount,
        bounds,
        visible: view.getVisible(),
        interrupt: () => {
          try {
            this.release(view);
          } catch (error) {
            lease.failure = error;
          }
        },
      };
      this.#active.set(view, lease);
      mount?.window.on("show", lease.interrupt);
      mount?.window.on("restore", lease.interrupt);
      mount?.window.on("hide", lease.interrupt);
      mount?.window.on("minimize", lease.interrupt);
      mount?.window.on("closed", lease.interrupt);
      let operationError: unknown;
      try {
        window.setIgnoreMouseEvents(true);
        mount?.window.contentView.removeChildView(view);
        window.contentView.addChildView(view);
        lease.attached = true;
        view.setBounds({ x: 0, y: 0, width, height });
        view.setVisible(true);
        window.showInactive();
        // Keep the existing non-activating renderer's compositor-settle turn.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (lease.released) {
          if (lease.failure !== undefined) throw lease.failure;
          // Preserve the old unmounted-to-human-mount inspection handoff. A
          // borrowed hidden mount, however, must never resume after takeover.
          if (!mount && currentMount()) return await operation();
          throw new Error(
            "Browser view changed during rendering; inspect again",
          );
        }
        if (
          window.isDestroyed() ||
          !window.contentView.children.includes(view) ||
          (mount && !mount.isCurrent())
        )
          throw new Error(
            "Browser view changed during rendering; inspect again",
          );
        const value = await operation();
        if (lease.failure !== undefined) throw lease.failure;
        if (
          lease.released ||
          window.isDestroyed() ||
          !window.contentView.children.includes(view) ||
          (mount && !mount.isCurrent())
        )
          throw new Error(
            "Browser view changed during rendering; inspect again",
          );
        return value;
      } catch (error) {
        operationError =
          lease.failure !== undefined && lease.failure !== error
            ? new AggregateError(
                [error, lease.failure],
                "Browser operation failed and renderer cleanup is unconfirmed",
              )
            : error;
        throw operationError;
      } finally {
        try {
          this.#release(view, lease, false);
        } catch (cleanupError) {
          if (operationError !== undefined)
            throw new AggregateError(
              [operationError, cleanupError],
              "Browser operation failed and renderer cleanup is unconfirmed",
            );
          throw cleanupError;
        }
      }
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(view, settled);
    void settled.then(() => {
      if (this.#tails.get(view) === settled) this.#tails.delete(view);
    });
    return await result;
  }

  /** User mount/hide/show/restore wins immediately, even while capture is pending. */
  release(view: WebContentsView): void {
    const lease = this.#active.get(view);
    if (lease) this.#release(view, lease, true);
  }

  #release(
    view: WebContentsView,
    lease: RenderLease,
    interrupted: boolean,
  ): void {
    if (this.#active.get(view) !== lease || lease.released) return;
    const current = lease.mount?.isCurrent() === true;
    const restore =
      current &&
      lease.mount !== undefined &&
      !lease.mount.window.isDestroyed() &&
      !view.webContents.isDestroyed();
    lease.released = true;
    this.#active.delete(view);
    lease.mount?.window.removeListener("show", lease.interrupt);
    lease.mount?.window.removeListener("restore", lease.interrupt);
    lease.mount?.window.removeListener("hide", lease.interrupt);
    lease.mount?.window.removeListener("minimize", lease.interrupt);
    lease.mount?.window.removeListener("closed", lease.interrupt);
    if (interrupted && current) lease.mount?.invalidate();
    if (lease.window.isDestroyed()) return;
    // Physical ownership is checked as well as the logical lease: a late
    // cleanup must never reparent a view already claimed by a newer mount.
    try {
      if (lease.window.contentView.children.includes(view)) {
        if (!view.webContents.isDestroyed()) view.setVisible(false);
        lease.window.contentView.removeChildView(view);
        if (restore) {
          lease.mount!.window.contentView.addChildView(view);
          view.setBounds(lease.bounds);
          view.setVisible(lease.visible);
        }
      } else if (
        !lease.attached &&
        restore &&
        !lease.mount!.window.contentView.children.includes(view)
      ) {
        // Attachment failed synchronously before any operation could begin.
        // The same logical owner can reclaim its detached, unborrowed view.
        lease.mount!.window.contentView.addChildView(view);
        view.setBounds(lease.bounds);
        view.setVisible(lease.visible);
      }
    } finally {
      // Never destroy a shared view if a native detach unexpectedly failed.
      if (!lease.window.contentView.children.includes(view))
        lease.window.destroy();
    }
  }

  close(): void {
    this.#closed = true;
    for (const view of this.#active.keys()) this.release(view);
  }
}

/** Bounds a read-only native capture; a late native reply is never published. */
export async function captureWorkspacePage(
  view: WebContentsView,
  invalidate: () => void,
  timeoutMs = 10_000,
): Promise<NativeImage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      view.webContents.capturePage(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          invalidate();
          reject(new Error("Browser native capture timed out; inspect again"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
