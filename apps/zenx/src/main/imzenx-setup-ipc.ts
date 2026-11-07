import { fileURLToPath } from "node:url";

/** The secure form accepts only our owned app window's exact renderer page. */
export function isTrustedImZenXSetupSender(
  sender: { ownedWindow: boolean; mainFrame: boolean; url: string },
  rendererUrl: string,
): boolean {
  if (!sender.ownedWindow || !sender.mainFrame) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(rendererUrl);
    actual.hash = "";
    expected.hash = "";
    if (actual.protocol === "file:" && expected.protocol === "file:") {
      // Electron loadFile and Node pathToFileURL spell some identical files
      // differently (RUNNER~1 versus RUNNER%7E1). Decode once, validating the
      // native path without resolving aliases, case or repeated separators.
      if (fileURLToPath(actual) !== fileURLToPath(expected)) return false;
      // Only equal native paths may share their encoding. Full href equality
      // still enforces exact authority/query, including a bare query marker.
      actual.pathname = expected.pathname;
    }
    return actual.href === expected.href;
  } catch {
    return false;
  }
}
