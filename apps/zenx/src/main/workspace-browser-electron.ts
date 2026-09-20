import { BrowserWindow, WebContentsView } from "electron";

import { WorkspaceBrowser } from "./workspace-browser.js";

export function createElectronWorkspaceBrowser(
  options: {
    artifactDirectory?: string;
    onCreateView?: (view: WebContentsView) => void;
  } = {},
): WorkspaceBrowser {
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
    },
  });
}
