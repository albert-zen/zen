import {
  isAppShotShortcutKind,
  type AppShotShortcutKind,
} from "../../app-shot.js";
import {
  APP_SHOT_DEFAULT_CHORD,
  appShotKeyChordPreference,
  parseAppShotKeyChord,
  validateAppShotKeyChord,
  type AppShotKeyChord,
} from "../../app-shot-key-chord.js";

const STORAGE_KEY = "zenx.appShot.shortcutKind";
export interface AppShotShortcutSelection {
  kind: AppShotShortcutKind;
  chord: AppShotKeyChord;
}

/** Read once per Composer. This preference never restores live authority. */
export function readAppShotShortcutPreference(
  platform: string,
): AppShotShortcutSelection {
  const supportsModifierPairs = platform === "darwin" || platform === "win32";
  const fallback: AppShotShortcutSelection = {
    kind: supportsModifierPairs ? "both-shift" : "chord",
    chord: APP_SHOT_DEFAULT_CHORD,
  };
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isAppShotShortcutKind(saved))
      return {
        ...fallback,
        kind: saved === "chord" || supportsModifierPairs ? saved : "chord",
      };
    if (saved && saved.length <= 300) {
      const value: unknown = JSON.parse(saved);
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        "kind" in value &&
        value.kind === "chord" &&
        "chord" in value
      ) {
        const parsed = parseAppShotKeyChord(value.chord);
        if (parsed)
          return {
            kind: "chord",
            chord: validateAppShotKeyChord(parsed, platform),
          };
      }
    }
  } catch {
    // Unavailable or invalid storage leaves this Composer at its platform default.
  }
  return fallback;
}

export function saveAppShotShortcutPreference(
  selection: AppShotShortcutSelection,
): boolean {
  if (!isAppShotShortcutKind(selection.kind)) return false;
  try {
    const chord = appShotKeyChordPreference(selection.chord);
    window.localStorage.setItem(
      STORAGE_KEY,
      selection.kind !== "chord" ||
        chord === appShotKeyChordPreference(APP_SHOT_DEFAULT_CHORD)
        ? selection.kind
        : JSON.stringify({ kind: "chord", chord }),
    );
    return true;
  } catch {
    return false;
  }
}
