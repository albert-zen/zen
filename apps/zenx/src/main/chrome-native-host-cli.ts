import path from "node:path";

import { ZENX_CHROME_EXTENSION_ORIGIN } from "./chrome-extension-bridge.js";
import {
  chromeNativeHostFailureDiagnostic,
  chromeNativeHostOrigin,
  chromeNativeHostUserDataDirectory,
  runChromeNativeHost,
  type ChromeNativeHostStage,
} from "./chrome-native-host.js";

let stage: ChromeNativeHostStage = "resolve-user-data";
try {
  const origin = chromeNativeHostOrigin(
    process.argv,
    ZENX_CHROME_EXTENSION_ORIGIN,
  );
  if (origin === undefined)
    throw new Error("Chrome native host origin is missing");
  const userDataDirectory = chromeNativeHostUserDataDirectory({
    argv: process.argv,
    commandLineValue:
      process.platform === "win32" && process.env.APPDATA !== undefined
        ? path.join(process.env.APPDATA, "zenx")
        : undefined,
  });
  if (userDataDirectory === undefined) {
    throw new Error("Chrome native host user data directory is unavailable");
  }
  await runChromeNativeHost({
    descriptorFile: path.join(
      userDataDirectory,
      "runtime",
      "chrome-bridge.json",
    ),
    origin,
    expectedOrigin: ZENX_CHROME_EXTENSION_ORIGIN,
    onStage: (nextStage) => {
      stage = nextStage;
    },
  });
  process.exit(0);
} catch (error) {
  process.stderr.write(chromeNativeHostFailureDiagnostic(error, stage));
  process.exit(1);
}
