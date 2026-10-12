import { i18n } from "./i18n.js";
import {
  createLanguageController,
  LANGUAGE_STORAGE_KEY,
  type LanguageController,
} from "./language-preference.js";

let controller: LanguageController | undefined;

export function getLanguageController(): LanguageController {
  controller ??= createLanguageController({
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    systemLanguages:
      typeof navigator === "undefined" ? ["en"] : navigator.languages,
    apply: (locale) => {
      if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
    },
  });
  return controller;
}

/** Initialize before React mounts, so the first interactive frame uses the saved language. */
export async function initializeLanguage(window: Window): Promise<() => void> {
  const systemLanguages = async () => {
    try {
      return await window.zenx.locale.getSystemLanguages();
    } catch {
      return [...window.navigator.languages];
    }
  };
  const languages = await systemLanguages();
  const storage = {
    getItem: (key: string) => window.localStorage.getItem(key),
    setItem: (key: string, value: string) =>
      window.localStorage.setItem(key, value),
  };
  const current = createLanguageController({
    storage,
    systemLanguages: languages,
    apply: (locale) => {
      if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
      window.document.documentElement.lang = locale;
      window.document.documentElement.dir = i18n.dir(locale);
      // Native UI follows the same preference; its failure must not block the renderer.
      void window.zenx?.locale?.setLanguage(locale).catch(() => {});
    },
  });
  controller = current;
  let disposed = false;
  let refreshVersion = 0;
  const refreshSystemLanguage = () => {
    const version = ++refreshVersion;
    void systemLanguages().then((next) => {
      if (!disposed && version === refreshVersion)
        current.setSystemLanguages(next);
    });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
      current.receivePreference(event.newValue);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("languagechange", refreshSystemLanguage);
  window.addEventListener("focus", refreshSystemLanguage);
  return () => {
    disposed = true;
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("languagechange", refreshSystemLanguage);
    window.removeEventListener("focus", refreshSystemLanguage);
    if (controller === current) controller = undefined;
  };
}
