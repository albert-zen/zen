import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import * as common from "./i18n/common.js";
import * as shell from "./i18n/shell.js";
import * as settings from "./i18n/settings.js";
import * as selector from "./i18n/selector.js";
import * as panels from "./i18n/panels.js";

export const resources = {
  en: {
    common: common.en,
    shell: shell.en,
    settings: settings.en,
    panels: panels.en,
    selector: selector.en,
  },
  "zh-CN": {
    common: common.zhCN,
    shell: shell.zhCN,
    settings: settings.zhCN,
    panels: panels.zhCN,
    selector: selector.zhCN,
  },
};

/** Bundled resources keep startup, language switching and offline use synchronous. */
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  defaultNS: "common",
  keySeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false }, // React escapes text at the rendering boundary.
  react: { useSuspense: false },
  returnNull: false,
  returnEmptyString: false,
});
