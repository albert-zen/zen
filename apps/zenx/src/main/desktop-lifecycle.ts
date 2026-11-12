export type ZenXDesktopPlatform = "darwin" | "win32" | "linux";

export function windowAllClosedDisposition(
  _platform: ZenXDesktopPlatform,
): "keep-host-running" {
  return "keep-host-running";
}

export function activationNeedsWindow(windowCount: number): boolean {
  return windowCount === 0;
}

export function secondInstanceDisposition(
  ownsSingleInstance: boolean,
): "own-authority" | "defer-to-owner" {
  return ownsSingleInstance ? "own-authority" : "defer-to-owner";
}
