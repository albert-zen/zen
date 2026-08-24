export const ZENX_ROOMS_TARBALL: string;

export function packZenXRoomsPlugin(options: {
  outputDirectory: string;
}): Promise<string>;
export function packZenXFirstPartyPlugins(options: {
  outputDirectory: string;
}): Promise<Array<{ packageName: string; tarball: string }>>;
