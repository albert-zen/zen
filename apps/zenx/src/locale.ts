export type SupportedLanguage = "en" | "zh-CN";
export type LanguagePreference = SupportedLanguage | "system";

export function normalizeLanguagePreference(
  value: unknown,
): LanguagePreference {
  return value === "en" || value === "zh-CN" ? value : "system";
}

/** Match available translations against the user's ordered BCP 47 preferences. */
export function resolveLanguage(
  preference: LanguagePreference,
  systemLanguages: readonly string[],
): SupportedLanguage {
  if (preference !== "system") return preference;
  for (const language of systemLanguages) {
    try {
      const locale = new Intl.Locale(language).maximize();
      if (locale.language === "en") return "en";
      if (locale.language === "zh" && locale.script === "Hans") return "zh-CN";
    } catch {
      // A malformed OS/browser locale must not prevent the app from opening.
    }
  }
  return "en";
}
