import {
  isAppShotShortcutKind,
  type AppShotShortcutKind,
} from "../../app-shot.js";

const STORAGE_KEY = "zenx.appShot.shortcutKind";

export function readAppShotShortcutPreference(
  platform: string,
): AppShotShortcutKind {
  const supportsModifierPairs = platform === "darwin" || platform === "win32";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (
      isAppShotShortcutKind(saved) &&
      (saved === "chord" || supportsModifierPairs)
    )
      return saved;
  } catch {
    // Unavailable storage leaves this Composer at its platform default.
  }
  return supportsModifierPairs ? "both-shift" : "chord";
}

export function saveAppShotShortcutPreference(
  kind: AppShotShortcutKind,
): boolean {
  if (!isAppShotShortcutKind(kind)) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, kind);
    return true;
  } catch {
    return false;
  }
}
