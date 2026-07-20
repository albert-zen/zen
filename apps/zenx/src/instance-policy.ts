export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): void;
};

export function acquireSingleInstance(app: SingleInstanceApp, focusExisting: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', focusExisting);
  return true;
}
