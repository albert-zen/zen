/** Default to the shared Workspace Browser; an explicit provider mode wins. */
export function useWorkspaceBrowserProvider(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.ZENX_BROWSER_MODE === undefined;
}
