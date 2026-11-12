import {
  normalizeLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  type SupportedLanguage,
} from "../../locale.js";
export { normalizeLanguagePreference, resolveLanguage } from "../../locale.js";
export type { LanguagePreference, SupportedLanguage } from "../../locale.js";
export const LANGUAGE_STORAGE_KEY = "zenx.language";

export function createLanguageController({
  storage,
  systemLanguages,
  apply,
}: {
  storage: Pick<Storage, "getItem" | "setItem">;
  systemLanguages: readonly string[];
  apply(locale: SupportedLanguage): void;
}) {
  let preference: LanguagePreference = "system";
  try {
    preference = normalizeLanguagePreference(
      storage.getItem(LANGUAGE_STORAGE_KEY),
    );
  } catch {
    /* Use the system preference if storage is unavailable. */
  }
  let locale = resolveLanguage(preference, systemLanguages);
  const listeners = new Set<() => void>();
  const update = () => {
    locale = resolveLanguage(preference, systemLanguages);
    apply(locale);
    for (const listener of listeners) listener();
  };
  apply(locale);
  return {
    getPreference: () => preference,
    getLocale: () => locale,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference(next: LanguagePreference): boolean {
      preference = normalizeLanguagePreference(next);
      let saved = true;
      try {
        storage.setItem(LANGUAGE_STORAGE_KEY, preference);
      } catch {
        saved = false;
      }
      update();
      return saved;
    },
    receivePreference(value: unknown) {
      preference = normalizeLanguagePreference(value);
      update();
    },
    setSystemLanguages(next: readonly string[]) {
      systemLanguages = next;
      if (preference === "system") update();
    },
  };
}
export type LanguageController = ReturnType<typeof createLanguageController>;
