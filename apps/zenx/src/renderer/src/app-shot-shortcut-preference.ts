import type { AppShotShortcutKind } from "../../app-shot.js";

const STORAGE_KEY = "zenx.appShot.shortcutKind";

export function readAppShotShortcutPreference(
  platform: string,
): AppShotShortcutKind {
  const supportsBothShift = platform === "darwin" || platform === "win32";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "chord" || (saved === "both-shift" && supportsBothShift))
      return saved;
  } catch {
    // Unavailable storage leaves this Composer at its platform default.
  }
  return supportsBothShift ? "both-shift" : "chord";
}

export function saveAppShotShortcutPreference(
  kind: AppShotShortcutKind,
): boolean {
  if (kind !== "both-shift" && kind !== "chord") return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, kind);
    return true;
  } catch {
    return false;
  }
}
