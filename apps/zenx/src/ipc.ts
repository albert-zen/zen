import { isAbsolute } from 'node:path';

import type { DesktopNotification, ZenDesktopBridge } from '@zen/framework/presentation';

const PICK_PROJECT_DIRECTORY = 'zenDesktop:pickProjectDirectory';
const SHOW_NOTIFICATION = 'zenDesktop:showNotification';
const MAX_NOTIFICATION_TITLE = 80;
const MAX_NOTIFICATION_BODY = 240;

export function createDesktopBridge(options: {
  readonly invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  readonly platform: string;
  readonly version: string;
}): ZenDesktopBridge {
  return Object.freeze({
    platform: options.platform,
    version: options.version,
    pickProjectDirectory: async () => {
      const selected = await options.invoke(PICK_PROJECT_DIRECTORY);
      return typeof selected === 'string' && isAbsolute(selected) ? selected : undefined;
    },
    showNotification: async (notification) => {
      await options.invoke(SHOW_NOTIFICATION, validateNotification(notification));
    },
  });
}

export function validateNotification(value: unknown): DesktopNotification {
  if (typeof value !== 'object' || value === null) throw new Error('Notification is required');
  const { title, body } = value as Record<string, unknown>;
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_NOTIFICATION_TITLE
  ) {
    throw new Error('Notification title is invalid');
  }
  if (typeof body !== 'string' || body.length > MAX_NOTIFICATION_BODY) {
    throw new Error('Notification body is invalid');
  }
  return { title, body };
}

export function registerDesktopIpc(
  ipc: {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  },
  capabilities: {
    chooseDirectory(): Promise<string | undefined>;
    showNotification(notification: DesktopNotification): void;
  }
): void {
  ipc.handle(PICK_PROJECT_DIRECTORY, async (_event, ...args) => {
    if (args.length > 0) return undefined;
    const selected = await capabilities.chooseDirectory();
    return selected !== undefined && isAbsolute(selected) ? selected : undefined;
  });
  ipc.handle(SHOW_NOTIFICATION, (_event, value, ...args) => {
    if (args.length > 0) throw new Error('Unexpected notification arguments');
    capabilities.showNotification(validateNotification(value));
  });
}
