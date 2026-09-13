import type { BrowserWindowConstructorOptions } from "electron";

// Keep the native material behind the renderer. Opaque CSS hides it when the
// preference is off, so switching never recreates the window or its contents.
export function windowBackdropOptions(
  platform: NodeJS.Platform,
  release: string,
): Pick<
  BrowserWindowConstructorOptions,
  "backgroundColor" | "backgroundMaterial" | "vibrancy"
> {
  if (platform === "darwin") {
    return { backgroundColor: "#00000000", vibrancy: "sidebar" };
  }
  if (platform === "win32" && Number(release.split(".")[2]) >= 22621) {
    return { backgroundColor: "#00000000", backgroundMaterial: "acrylic" };
  }
  return { backgroundColor: "#0b0d10" };
}
