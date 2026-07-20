export type DesktopNotification = {
  readonly title: string;
  readonly body: string;
};

export type ZenDesktopBridge = {
  readonly platform: string;
  readonly version: string;
  pickProjectDirectory(): Promise<string | undefined>;
  showNotification(notification: DesktopNotification): Promise<void>;
};
