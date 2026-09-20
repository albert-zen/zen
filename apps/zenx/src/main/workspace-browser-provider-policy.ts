/** Keep the shared Workspace Browser unless an env override or saved Chrome opt-in selects a provider. */
export function useWorkspaceBrowserProvider(
  environment: NodeJS.ProcessEnv,
  configuredMode?: "isolated" | "user-session",
): boolean {
  if (environment.ZENX_BROWSER_MODE !== undefined) return false;
  return configuredMode !== "user-session";
}
