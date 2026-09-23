import { BrowserWindow, WebContentsView } from "electron";

import { WorkspaceBrowser } from "./workspace-browser.js";

export function createElectronWorkspaceBrowser(
  options: {
    artifactDirectory?: string;
    onCreateView?: (view: WebContentsView) => void;
  } = {},
): WorkspaceBrowser {
  const unmountedRenderer = new UnmountedWorkspaceRenderer();
  return new WorkspaceBrowser({
    ...(options.artifactDirectory === undefined
      ? {}
      : { artifactDirectory: options.artifactDirectory }),
    dependencies: {
      createView: () => {
        const view = new WebContentsView({
          webPreferences: {
            partition: "persist:zenx-workspace-browser",
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        });
        options.onCreateView?.(view);
        return view;
      },
      windowFor: (sender) => BrowserWindow.fromWebContents(sender),
      renderWhileUnmounted: (view, isMounted, operation) =>
        unmountedRenderer.render(view, isMounted, operation),
      releaseUnmountedView: (view) => unmountedRenderer.release(view),
      closeUnmountedRenderer: () => unmountedRenderer.close(),
    },
  });
}

/** Gives an unmounted shared page a real viewport during an Agent operation. */
class UnmountedWorkspaceRenderer {
  readonly #active = new Map<
    WebContentsView,
    { window: BrowserWindow; released: boolean }
  >();
  readonly #tails = new Map<WebContentsView, Promise<void>>();
  #closed = false;

  async render<T>(
    view: WebContentsView,
    isMounted: () => boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#tails.get(view) ?? Promise.resolve();
    const result = prior.then(async () => {
      if (this.#closed || view.webContents.isDestroyed()) {
        throw new Error("Browser tab closed before rendering");
      }
      if (isMounted()) return await operation();

      const window = new BrowserWindow({
        width: 1280,
        height: 800,
        x: -10000,
        y: -10000,
        show: false,
        focusable: false,
        skipTaskbar: true,
        opacity: 0,
      });
      window.setIgnoreMouseEvents(true);
      const lease = { window, released: false };
      this.#active.set(view, lease);
      try {
        window.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
        view.setVisible(true);
        window.showInactive();
        // Chromium needs one compositor turn after attaching a page that was
        // created without a parent; an immediate capture returns no pixels.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (lease.released) {
          if (isMounted()) return await operation();
          throw new Error(
            "Browser view changed during rendering; inspect again",
          );
        }
        return await operation();
      } finally {
        this.release(view, lease);
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

  release(
    view: WebContentsView,
    expected?: { window: BrowserWindow; released: boolean },
  ): void {
    const lease = this.#active.get(view);
    if (lease === undefined || (expected !== undefined && lease !== expected))
      return;
    lease.released = true;
    this.#active.delete(view);
    if (lease.window.isDestroyed()) return;
    if (lease.window.contentView.children.includes(view)) {
      if (!view.webContents.isDestroyed()) view.setVisible(false);
      lease.window.contentView.removeChildView(view);
    }
    lease.window.destroy();
  }

  close(): void {
    this.#closed = true;
    for (const view of this.#active.keys()) this.release(view);
  }
}
