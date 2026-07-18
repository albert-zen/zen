import type { ZenDesktopBridge } from '../../desktop/ipc.js';

declare global {
  interface Window {
    zenDesktop?: ZenDesktopBridge;
  }
}

export {};
