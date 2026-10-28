import path from "node:path";
import { localErrorDetail } from "../local-error-detail.js";
import { BoundedLocalDiagnosticLog } from "./bounded-diagnostic-log.js";
import type { ChromeNativeHostStage } from "./chrome-native-host.js";

/** Owner-local failure details; never send the bridge URL/cause to Chrome stderr. */
export async function recordChromeNativeHostFailure(
  userDataDirectory: string | undefined,
  stage: ChromeNativeHostStage,
  error: unknown,
): Promise<string> {
  if (userDataDirectory === undefined)
    return "Local details unavailable: user data directory was not resolved.\n";
  const file = path.join(
    userDataDirectory,
    "diagnostics",
    "chrome-native-host.jsonl",
  );
  try {
    const record = {
      timestamp: new Date().toISOString(),
      stage,
      detail: localErrorDetail(error),
    };
    const log = new BoundedLocalDiagnosticLog({
      userDataDirectory,
      fileName: "chrome-native-host.jsonl",
      // Only the explicit owner-local fields above; never serialize configuration.
      normalize: () => record,
      maxBytes: 1024 * 1024,
    });
    if (!(await log.record(record)))
      return "Local details unavailable: diagnostic record exceeded its storage limit.\n";
    return `Local details: ${file} (Settings → Local diagnostics; not automatically shared).\n`;
  } catch {
    return "Local details unavailable: diagnostic storage failed.\n";
  }
}
