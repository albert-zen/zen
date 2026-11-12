export const SHELL_PTY_PATCH: Readonly<{
  version: string;
  file: string;
  originalSha256: string;
  patchedSha256: string;
}>;
export function verifyShellPtyPatch(directory: string): Promise<void>;
export function applyShellPtyPatch(directory: string): Promise<void>;
