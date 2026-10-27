import type { Plugin } from "vite";
export function bundledLicenseNotices(options?: {
  rootDirectory?: string;
}): Plugin;
export function collectBundledLicenseNotices(
  moduleIds: string[],
  options?: { rootDirectory?: string },
): Promise<string>;
