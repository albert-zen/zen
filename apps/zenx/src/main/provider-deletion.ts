import type {
  PublicHostSettings,
  ZenXProviderDeleteReplacements,
} from "./host-profile.js";
import {
  ZenXProviderDeletionCleanupError,
  type ZenXSettingsService,
} from "./settings-service.js";

export async function deleteProviderProfileWithHostRestart(
  settings: ZenXSettingsService,
  providerProfileId: string,
  replacements: ZenXProviderDeleteReplacements,
  restartHost: () => Promise<void>,
): Promise<PublicHostSettings> {
  let cleanupError: ZenXProviderDeletionCleanupError | undefined;
  try {
    await settings.deleteProviderProfile(providerProfileId, replacements);
  } catch (error) {
    if (!(error instanceof ZenXProviderDeletionCleanupError)) throw error;
    cleanupError = error;
  }

  let restartError: unknown;
  try {
    await restartHost();
  } catch (error) {
    restartError = error;
  }

  if (cleanupError !== undefined && restartError !== undefined) {
    throw new AggregateError(
      [cleanupError, restartError],
      "Provider deletion was committed, but subscription cleanup and Host restart both failed",
    );
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (restartError !== undefined) throw restartError;
  return await settings.publicSettings();
}
