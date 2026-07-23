import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentAppHttpTransport, AgentAppProductionComposition } from '@zen/framework/node';
import { resolveDesktopAppServerMode } from './app-server-mode.js';
import { acquireSingleInstance } from './instance-policy.js';
import { registerDesktopIpc } from './ipc.js';
import {
  closeWithBoundedRetry,
  DesktopLifecycle,
  installShutdownFile,
  installShutdownSignals,
} from './lifecycle.js';
import { serveDesktopStaticHost, type DesktopStaticHost } from './static-host.js';
import { createWindowOptions, installWindowPolicy } from './window-policy.js';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));

void runDesktop().catch((cause: unknown) => {
  console.error('Zen desktop startup failed', cause);
  app.quit();
});

async function runDesktop(): Promise<void> {
  const lifecycle = new DesktopLifecycle();
  const appServerMode = resolveDesktopAppServerMode(process.env);
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
    void closeWithBoundedRetry(() => lifecycle.close(), {
      attempts: 2,
      attemptTimeoutMs: 2_000,
      onFailure: (cause, attempt) =>
        console.error(`Zen desktop shutdown attempt ${attempt} failed`, cause),
    })
      .catch((cause: unknown) => console.error('Zen desktop shutdown retries failed', cause))
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
  const removeShutdownFile = installShutdownFile(process.env.ZEN_DESKTOP_SHUTDOWN_FILE, shutdown);
  app.once('will-quit', () => {
    removeShutdownSignals();
    removeShutdownFile();
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

  const createWindow = async (host: unknown) => {
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
  };

  if (appServerMode.type === 'external') {
    await lifecycle.startExternal({
      createHost: async () =>
        await serveDesktopStaticHost({
          apiTarget: appServerMode.url,
          capability: appServerMode.capability,
          staticRoot: join(desktopDirectory, 'web'),
        }),
      createWindow,
    });
    console.log('ZenX connected to the shared Zen App Server.');
    return;
  }

  const {
    createAgentAppProductionComposition,
    resolveAgentAppDataRoot,
    serveAgentAppHttpTransport,
  } = await import('@zen/framework/node');
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
    createWindow,
  });
}
