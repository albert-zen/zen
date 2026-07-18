import { createProviderBackedAppServer } from './provider-runtime.js';

/**
 * Legacy TUI execution is intentionally isolated from the Agent App network
 * surface. APP-006 replaces this adapter with the project-scoped TUI client.
 */
export async function createLegacyTuiClient(cwd: string) {
  return await createProviderBackedAppServer({ cwd });
}
