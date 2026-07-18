export type WindowOpenHandler = (details: { readonly url: string }) => { readonly action: 'deny' };

export type DesktopWindow = {
  readonly webContents: {
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(handler: WindowOpenHandler): void;
  };
};

export type ExternalOpener = {
  openExternal(url: string): Promise<void>;
};

export function createWindowOptions(preload: string): {
  readonly height: number;
  readonly minHeight: number;
  readonly minWidth: number;
  readonly show: false;
  readonly title: string;
  readonly width: number;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly preload: string;
    readonly sandbox: true;
    readonly webSecurity: true;
  };
} {
  return {
    height: 860,
    minHeight: 600,
    minWidth: 900,
    show: false,
    title: 'Zen Agent',
    width: 1280,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: true,
      webSecurity: true,
    },
  };
}

export function installWindowPolicy(window: DesktopWindow, external: ExternalOpener): void {
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void external.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
}

function isExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
