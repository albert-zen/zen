/** An external-browser opt-in adds a backend; it never replaces Workspace tabs. */
export function useWorkspaceBrowserProvider(
  environment: NodeJS.ProcessEnv,
  _configuredMode?: "isolated" | "user-session",
): boolean {
  return (
    environment.ZENX_BROWSER_MODE === undefined ||
    environment.ZENX_BROWSER_MODE === "user-session"
  );
}
