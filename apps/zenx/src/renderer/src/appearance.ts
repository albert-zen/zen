export const APPEARANCE_STORAGE_KEY = "zenx.appearance";

export const APPEARANCE_MODES = ["system", "light", "dark"] as const;
export const APPEARANCE_PRESETS = ["graphite", "cobalt", "ember"] as const;
export const APPEARANCE_ACCENTS = ["azure", "iris", "jade"] as const;
export const APPEARANCE_CONTRASTS = ["standard", "high"] as const;

export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export type AppearancePreset = (typeof APPEARANCE_PRESETS)[number];
export type AppearanceAccent = (typeof APPEARANCE_ACCENTS)[number];
export type AppearanceContrast = (typeof APPEARANCE_CONTRASTS)[number];
export type ResolvedAppearanceMode = Exclude<AppearanceMode, "system">;

export interface AppearancePreference {
  mode: AppearanceMode;
  lightPreset: AppearancePreset;
  darkPreset: AppearancePreset;
  accent: AppearanceAccent;
  contrast: AppearanceContrast;
  translucentSidebar: boolean;
}

export interface ResolvedAppearance {
  mode: ResolvedAppearanceMode;
  preset: AppearancePreset;
  accent: AppearanceAccent;
  contrast: AppearanceContrast;
  translucentSidebar: boolean;
}

export const DEFAULT_APPEARANCE_PREFERENCE: Readonly<AppearancePreference> =
  Object.freeze({
    mode: "system",
    lightPreset: "graphite",
    darkPreset: "graphite",
    accent: "azure",
    contrast: "standard",
    translucentSidebar: false,
  });

export interface AppearanceController {
  getPreference(): AppearancePreference;
  setPreference(preference: AppearancePreference): void;
  reset(): void;
  dispose(): void;
}

interface SystemAppearancePreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return APPEARANCE_MODES.some((mode) => mode === value);
}

export function readAppearancePreference(
  storage: Pick<Storage, "getItem">,
): AppearancePreference {
  try {
    const stored = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (isAppearanceMode(stored)) {
      return { ...DEFAULT_APPEARANCE_PREFERENCE, mode: stored };
    }
    if (stored === null) return { ...DEFAULT_APPEARANCE_PREFERENCE };
    return normalizeAppearancePreference(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_APPEARANCE_PREFERENCE };
  }
}

export function normalizeAppearancePreference(
  value: unknown,
): AppearancePreference {
  if (!isRecord(value)) return { ...DEFAULT_APPEARANCE_PREFERENCE };
  return {
    mode: oneOf(value.mode, APPEARANCE_MODES, "system"),
    lightPreset: oneOf(value.lightPreset, APPEARANCE_PRESETS, "graphite"),
    darkPreset: oneOf(value.darkPreset, APPEARANCE_PRESETS, "graphite"),
    accent: oneOf(value.accent, APPEARANCE_ACCENTS, "azure"),
    contrast: oneOf(value.contrast, APPEARANCE_CONTRASTS, "standard"),
    translucentSidebar: value.translucentSidebar === true,
  };
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemDark: boolean,
): ResolvedAppearance {
  const mode =
    preference.mode === "system"
      ? systemDark
        ? "dark"
        : "light"
      : preference.mode;
  return {
    mode,
    preset: mode === "light" ? preference.lightPreset : preference.darkPreset,
    accent: preference.accent,
    contrast: preference.contrast,
    translucentSidebar: preference.translucentSidebar,
  };
}

export function applyResolvedAppearance(
  document: Document,
  appearance: ResolvedAppearance,
): void {
  const root = document.documentElement;
  root.dataset.appearance = appearance.mode;
  root.dataset.themePreset = appearance.preset;
  root.dataset.accent = appearance.accent;
  root.dataset.contrast = appearance.contrast;
  root.dataset.sidebarTranslucency = appearance.translucentSidebar
    ? "on"
    : "off";
  root.style.colorScheme = appearance.mode;
  document
    .querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
    ?.setAttribute("content", appearance.mode);
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
    if (preference.mode === "system") apply();
  };
  systemPreference.addEventListener("change", onSystemChange);
  apply();
  return {
    getPreference: () => ({ ...preference }),
    setPreference: (next) => {
      preference = normalizeAppearancePreference(next);
      try {
        storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preference));
      } catch {
        // The in-memory choice still applies when storage is unavailable.
      }
      apply();
    },
    reset: () => {
      preference = { ...DEFAULT_APPEARANCE_PREFERENCE };
      try {
        storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preference));
      } catch {
        // The in-memory defaults still apply when storage is unavailable.
      }
      apply();
    },
    dispose: () =>
      systemPreference.removeEventListener("change", onSystemChange),
  };
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return options.some((option) => option === value) ? (value as T) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
