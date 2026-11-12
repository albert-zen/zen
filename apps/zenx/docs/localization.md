# Interface localization

ZenX includes English (`en`) and Simplified Chinese (`zh-CN`). Choose **Settings → General → Language** to switch immediately, or select **Follow system**. Language names remain in their own language so the setting can be found after an accidental switch.

The preference is local to the desktop installation, like appearance. It is saved as `zenx.language` in renderer local storage and shared by windows on the same app origin. Development and packaged app origins have separate preferences. It does not change the agent's instructions, response language, conversation history, model or plugin data. Third-party plugin content and service error messages retain their source language.

System mode uses Electron's ordered `app.getPreferredSystemLanguages()` list. BCP 47 locales are matched with `Intl.Locale`: English variants map to English, Chinese with the Hans script maps to Simplified Chinese. Unsupported languages, including Hant-only preferences, fall back to English. System preferences are rechecked when the window regains focus. The renderer's browser language list is a fallback if the host locale API is unavailable.

## Adding or changing messages

- Use `useTranslation(namespace)` in React components; use the exported `i18n` instance only in non-React helpers called during rendering or event handling. Do not translate a module-level constant once or cache translated labels without a language dependency.
- Catalogs in `src/renderer/src/i18n/` group messages into `common`, `shell`, `settings`, `panels`, and `selector`. Keys are flat, stable identifiers. Keep English and Chinese keys and interpolation variables aligned; the catalog test checks both.
- Translate full sentences. Use named interpolation for runtime values and i18next plural forms with the `count` option. Avoid building grammatical sentences from translated fragments. Never translate or rewrite user content, prompts, paths, identifiers, raw tool output, or provider/plugin metadata.
- React escapes translated text; do not pass translations to `innerHTML` or `dangerouslySetInnerHTML`. `escapeValue: false` avoids double escaping at the React rendering boundary.
- Pass the active locale to `Intl.NumberFormat` / `Intl.DateTimeFormat`. Label icons and inputs in the selected language and allow longer text to wrap. The document's `lang` and `dir` are updated at startup and on language changes.
- Resources ship in the application; no remote translation service or network fetch is required. English is the runtime fallback for a missing translation. Add a new language to the resources, locale matcher, selector, and catalog tests together; do not offer incomplete catalogs as supported languages.

Native menu labels and app-owned file-dialog/unsaved-edit prompts follow the resolved interface language. Operating-system-owned dialog controls remain controlled by the OS.

## Verification

Run `npm --workspace apps/zenx run check`. The language tests cover ordered detection, persistence across recreation, cross-window updates, unavailable storage, catalog parity, interpolation, pluralization, English fallback, native copy, and live React updates. For manual verification, switch languages in General, revisit Settings and a conversation, reopen the window, and verify the selected language remains. Check a narrow window and keyboard access to the language selector.

## Design references

This implementation follows [i18next's complete-message guidance](https://www.i18next.com/principles/best-practices), [fallback resolution](https://www.i18next.com/principles/fallback), [plural rules](https://www.i18next.com/translation-function/plurals), [React language subscriptions](https://react.i18next.com/latest/usetranslation-hook), and [Electron's preferred system language API](https://www.electronjs.org/docs/latest/api/app#getpreferredsystemlanguages).
