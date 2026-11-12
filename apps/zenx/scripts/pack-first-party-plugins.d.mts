export const ZENX_ROOMS_TARBALL: string;
export const FIRST_PARTY_PLUGINS: readonly Readonly<{
  packageName: string;
  directory: string;
  tarball: string;
  manifest?: string;
}>[];

export function packZenXRoomsPlugin(options: {
  outputDirectory: string;
}): Promise<string>;
export function packZenXFirstPartyPlugins(options: {
  outputDirectory: string;
}): Promise<Array<{ packageName: string; tarball: string }>>;
