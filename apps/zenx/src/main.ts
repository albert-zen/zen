import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentAppProductionComposition,
  resolveAgentAppDataRoot,
  serveAgentAppHttpTransport,
  type AgentAppHttpTransport,
  type AgentAppProductionComposition,
} from '@zen/framework/node';
import { acquireSingleInstance } from './instance-policy.js';
import { registerDesktopIpc } from './ipc.js';
import { DesktopLifecycle, installShutdownSignals } from './lifecycle.js';
import { serveDesktopStaticHost, type DesktopStaticHost } from './static-host.js';
import { createWindowOptions, installWindowPolicy } from './window-policy.js';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));

void runDesktop().catch((cause: unknown) => {
  console.error('Zen desktop startup failed', cause);
  app.quit();
});

async function runDesktop(): Promise<void> {
  const lifecycle = new DesktopLifecycle();
  let mainWindow: BrowserWindow | undefined;
  if (
    !acquireSingleInstance(app, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    })
  ) {
    app.quit();
    return;
  }
  let nativeQuitAllowed = false;
  let shutdownRequested = false;
  const shutdown = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    void lifecycle
      .close()
      .catch((cause: unknown) => console.error('Zen desktop shutdown failed', cause))
      .finally(() => {
        nativeQuitAllowed = true;
        app.quit();
      });
  };

  app.on('before-quit', (event) => {
    if (nativeQuitAllowed) return;
    event.preventDefault();
    shutdown();
  });
  app.on('window-all-closed', shutdown);
  const removeShutdownSignals = installShutdownSignals(process, shutdown);
  app.once('will-quit', () => {
    removeShutdownSignals();
  });

  await app.whenReady();
  registerDesktopIpc(ipcMain, {
    chooseDirectory: async () => {
      const selection = await dialog.showOpenDialog({
        properties: ['createDirectory', 'openDirectory'],
      });
      return selection.canceled ? undefined : selection.filePaths[0];
    },
    showNotification: (notification) => new Notification(notification).show(),
  });

  await lifecycle.start({
    createComposition: async () =>
      await createAgentAppProductionComposition({ appDataRoot: resolveAgentAppDataRoot() }),
    createTransport: async (composition) =>
      await serveAgentAppHttpTransport({
        agentAppServer: (composition as AgentAppProductionComposition).agentAppServer,
        host: '127.0.0.1',
        port: 0,
      }),
    createHost: async (transport) => {
      const agentTransport = transport as AgentAppHttpTransport;
      return await serveDesktopStaticHost({
        apiTarget: agentTransport.url,
        capability: agentTransport.capability,
        staticRoot: join(desktopDirectory, 'web'),
      });
    },
    createWindow: async (host) => {
      const staticHost = host as DesktopStaticHost;
      const window = new BrowserWindow(createWindowOptions(join(desktopDirectory, 'preload.js')));
      mainWindow = window;
      installWindowPolicy(window, shell);
      window.on('close', (event) => {
        if (nativeQuitAllowed) return;
        event.preventDefault();
        shutdown();
      });
      window.webContents.on('render-process-gone', (_event, details) =>
        console.error('Zen renderer process exited', details.reason)
      );
      window.on('unresponsive', () => console.error('Zen renderer is unresponsive'));
      window.once('ready-to-show', () => {
        if (process.env.ZEN_DESKTOP_HIDE !== '1') window.show();
      });
      await window.loadURL(staticHost.url);
      const autoQuitMs = Number(process.env.ZEN_DESKTOP_AUTO_QUIT_MS);
      if (Number.isSafeInteger(autoQuitMs) && autoQuitMs > 0) setTimeout(shutdown, autoQuitMs);
      return {
        close: () => {
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
  });
}
