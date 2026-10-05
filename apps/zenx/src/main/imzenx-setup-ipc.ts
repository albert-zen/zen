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
    return actual.href === expected.href;
  } catch {
    return false;
  }
}
