import type { BrowserWindowConstructorOptions } from "electron";

// An opaque window keeps desktop colors out of every renderer theme.
export function windowBackdropOptions(): Pick<
  BrowserWindowConstructorOptions,
  "backgroundColor"
> {
  return { backgroundColor: "#0b0d10" };
}
