export const APPEARANCE_STORAGE_KEY = "zenx.appearance";

export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;

export interface AppearanceController {
  getPreference(): AppearancePreference;
  setPreference(preference: AppearancePreference): void;
  dispose(): void;
}

interface SystemAppearancePreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function isAppearancePreference(
  value: unknown,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readAppearancePreference(
  storage: Pick<Storage, "getItem">,
): AppearancePreference {
  try {
    const value = storage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearancePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemDark: boolean,
): ResolvedAppearance {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyResolvedAppearance(
  document: Document,
  appearance: ResolvedAppearance,
): void {
  document.documentElement.dataset.appearance = appearance;
  document.documentElement.style.colorScheme = appearance;
  document
    .querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
    ?.setAttribute("content", appearance);
}

export function createAppearanceController({
  document,
  storage,
  systemPreference,
}: {
  document: Document;
  storage: Pick<Storage, "getItem" | "setItem">;
  systemPreference: SystemAppearancePreference;
}): AppearanceController {
  let preference = readAppearancePreference(storage);
  const apply = () =>
    applyResolvedAppearance(
      document,
      resolveAppearance(preference, systemPreference.matches),
    );
  const onSystemChange = () => {
    if (preference === "system") apply();
  };
  systemPreference.addEventListener("change", onSystemChange);
  apply();
  return {
    getPreference: () => preference,
    setPreference: (next) => {
      preference = next;
      try {
        storage.setItem(APPEARANCE_STORAGE_KEY, next);
      } catch {
        // The in-memory choice still applies when storage is unavailable.
      }
      apply();
    },
    dispose: () =>
      systemPreference.removeEventListener("change", onSystemChange),
  };
}

let sharedController: AppearanceController | undefined;

export function getAppearanceController(): AppearanceController {
  sharedController ??= createAppearanceController({
    document,
    storage: localStorage,
    systemPreference: matchMedia("(prefers-color-scheme: dark)"),
  });
  return sharedController;
}
