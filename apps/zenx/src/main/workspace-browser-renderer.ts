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
  cancelFrame?: () => void;
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
    readonly displayScale: (window: BrowserWindow) => number,
    readonly frameTimeoutMs = 5_000,
  ) {}

  async render<T>(
    view: WebContentsView,
    currentMount: () => WorkspaceBrowserRenderMount | undefined,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const prior = this.#tails.get(view) ?? Promise.resolve();
    const result = prior.then(async () => {
      signal?.throwIfAborted();
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
        await this.#awaitFrame(view, lease, width, height, signal);
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

  #awaitFrame(
    view: WebContentsView,
    lease: RenderLease,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let subscribed = false;
      let activated = false;
      let scale = 0;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        lease.cancelFrame = undefined;
        try {
          if (subscribed && !view.webContents.isDestroyed())
            view.webContents.endFrameSubscription();
        } catch (cleanup) {
          error =
            error === undefined
              ? cleanup
              : new AggregateError(
                  [error, cleanup],
                  "Frame wait failed and subscription cleanup is unconfirmed",
                );
        }
        if (error === undefined) resolve();
        else reject(error);
      };
      const aborted = () => {
        finish(signal?.reason ?? new Error("Browser rendering cancelled"));
        try {
          this.release(view);
        } catch (error) {
          lease.failure = error;
        }
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error("Browser compositor frame timed out; inspect again"),
          ),
        this.frameTimeoutMs,
      );
      // A release unblocks the wait; the caller's existing ownership check
      // rejects it, except for the existing unmounted-to-human-mount handoff.
      lease.cancelFrame = () => finish();
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      try {
        subscribed = true;
        view.webContents.beginFrameSubscription(false, (image) => {
          if (settled || !activated) return;
          try {
            if (
              lease.released ||
              lease.window.isDestroyed() ||
              !lease.window.contentView.children.includes(view) ||
              (lease.mount && !lease.mount.isCurrent()) ||
              this.displayScale(lease.window) !== scale
            ) {
              finish(
                new Error(
                  "Browser view changed during rendering; inspect again",
                ),
              );
              return;
            }
            // Electron 43 uses float32 SizeF multiplication, then rounds,
            // then wraps the physical bitmap as a 1x NativeImage. CSS zoom and
            // innerWidth are not the source of these dimensions.
            const size = image.getSize();
            if (
              !image.isEmpty() &&
              size.width ===
                Math.round(
                  Math.fround(Math.fround(width) * Math.fround(scale)),
                ) &&
              size.height ===
                Math.round(
                  Math.fround(Math.fround(height) * Math.fround(scale)),
                )
            )
              finish();
          } catch (error) {
            finish(error);
          }
        });
        if (!settled) {
          lease.window.showInactive();
          scale = this.displayScale(lease.window);
          if (!Number.isFinite(scale) || scale <= 0)
            throw new Error("Browser compositor display scale is unavailable");
          activated = true;
        }
      } catch (error) {
        finish(error);
      }
    });
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
    lease.cancelFrame?.();
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

/** Bounds a fresh read-only native capture; late replies never dispatch or publish. */
export async function captureWorkspacePage(
  view: WebContentsView,
  invalidate: () => void,
  timeoutMs = 10_000,
  assertCurrent: () => void = () => undefined,
): Promise<NativeImage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const capture = async () => {
    const web = view.webContents;
    const bounds = view.getBounds();
    const debuggerApi = web.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    // Frame subscriptions can start with the previously submitted surface.
    // Chromium's screenshot path requests a renderer redraw/new surface and
    // acknowledges its copy. Its disposable JPEG is never retained. Preserve
    // capturePage's NativeImage/DIP rounding contract only after that causal
    // fence; do not count frames or sleep.
    await debuggerApi.sendCommand("Page.captureScreenshot", {
      format: "jpeg",
      quality: 0,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (expired)
      throw new Error("Browser native capture timed out; inspect again");
    assertCurrent();
    if (web.isDestroyed())
      throw new Error("Browser tab closed during rendering; inspect again");
    const currentBounds = view.getBounds();
    if (
      currentBounds.x !== bounds.x ||
      currentBounds.y !== bounds.y ||
      currentBounds.width !== bounds.width ||
      currentBounds.height !== bounds.height
    )
      throw new Error("Browser view changed during rendering; inspect again");
    return await web.capturePage();
  };
  try {
    return await Promise.race([
      capture(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          invalidate();
          reject(new Error("Browser native capture timed out; inspect again"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
