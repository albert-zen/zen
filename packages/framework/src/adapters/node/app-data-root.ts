import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type AgentAppDataRootEnvironment = Readonly<Record<string, string | undefined>>;

/** Production state belongs to the OS user-data boundary, never the workspace. */
export function resolveAgentAppDataRoot(
  environment: AgentAppDataRootEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir()
): string {
  const path = platform === 'win32' ? win32 : posix;
  const explicit = environment.ZEN_APP_DATA_ROOT?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('ZEN_APP_DATA_ROOT must be an absolute path');
    return path.resolve(explicit);
  }

  if (platform === 'win32') {
    const base = environment.LOCALAPPDATA?.trim() || environment.APPDATA?.trim();
    if (!base || !path.isAbsolute(base)) {
      throw new Error('Windows app-data directory is unavailable');
    }
    return path.resolve(base, 'Zen Agent');
  }
  if (platform === 'darwin') {
    return path.resolve(homeDirectory, 'Library', 'Application Support', 'Zen Agent');
  }
  const stateHome = environment.XDG_STATE_HOME?.trim();
  if (stateHome) {
    if (!path.isAbsolute(stateHome)) throw new Error('XDG_STATE_HOME must be an absolute path');
    return path.resolve(stateHome, 'zen-agent');
  }
  return path.resolve(homeDirectory, '.local', 'state', 'zen-agent');
}
