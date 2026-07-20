import type { ZenDesktopBridge } from '@zen/framework/presentation';

declare global {
  interface Window {
    zenDesktop?: ZenDesktopBridge;
  }
}

export {};
