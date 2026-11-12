import { BrowserWindow, WebContentsView, screen } from "electron";

import { WorkspaceBrowser } from "./workspace-browser.js";
import { WorkspaceBrowserRenderer } from "./workspace-browser-renderer.js";

export function createElectronWorkspaceBrowser(
  options: {
    artifactDirectory?: string;
    onCreateView?: (view: WebContentsView) => void;
  } = {},
): WorkspaceBrowser {
  const unmountedRenderer = new WorkspaceBrowserRenderer(
    (options) => new BrowserWindow(options),
    (window) => screen.getDisplayMatching(window.getBounds()).scaleFactor,
  );
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
      renderWhileUnmounted: (view, isMounted, operation, signal) =>
        unmountedRenderer.render(view, isMounted, operation, signal),
      releaseUnmountedView: (view) => unmountedRenderer.release(view),
      closeUnmountedRenderer: () => unmountedRenderer.close(),
    },
  });
}
