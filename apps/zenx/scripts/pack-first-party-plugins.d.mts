export const ZENX_ROOMS_TARBALL: string;

export function packZenXRoomsPlugin(options: {
  outputDirectory: string;
}): Promise<string>;
