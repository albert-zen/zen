import type { NativeImage } from "electron";

export const USER_BROWSER_MAX_LIVE_CAPTURE_BYTES = 16 * 1024 * 1024;
export const USER_BROWSER_MAX_LIVE_CAPTURE_DIMENSION = 16_384;
export const USER_BROWSER_MAX_LIVE_CAPTURE_PIXELS = 64 * 1024 * 1024;
export const USER_BROWSER_MAX_LIVE_FRAME_BYTES = 1024 * 1024;

const USER_BROWSER_MAX_LIVE_FRAME_WIDTH = 1_600;
const USER_BROWSER_MAX_LIVE_FRAME_HEIGHT = 1_000;

export interface UserBrowserLiveImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number }): UserBrowserLiveImage;
  toJPEG(quality: number): Buffer;
}

export type UserBrowserLiveImageDecoder = (
  encoded: Buffer,
) => UserBrowserLiveImage | Promise<UserBrowserLiveImage>;

let electronDecoder: Promise<(encoded: Buffer) => NativeImage> | undefined;

async function decodeElectronImage(encoded: Buffer): Promise<NativeImage> {
  electronDecoder ??= import("electron").then(
    ({ nativeImage }) =>
      (data: Buffer) =>
        nativeImage.createFromBuffer(data),
  );
  return (await electronDecoder)(encoded);
}

export async function processUserBrowserLiveFrame(
  data: unknown,
  decode: UserBrowserLiveImageDecoder = decodeElectronImage,
): Promise<{ data: string; width: number; height: number }> {
  const maxEncodedLength =
    Math.ceil(USER_BROWSER_MAX_LIVE_CAPTURE_BYTES / 3) * 4 + 4;
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > maxEncodedLength ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) ||
    Buffer.byteLength(data, "base64") > USER_BROWSER_MAX_LIVE_CAPTURE_BYTES
  ) {
    throw new Error("Browser live capture exceeded its input size bound");
  }

  let image = await decode(Buffer.from(data, "base64"));
  if (image.isEmpty()) throw new Error("Browser live capture is empty");
  const source = image.getSize();
  if (
    !validDimension(source.width) ||
    !validDimension(source.height) ||
    source.width > USER_BROWSER_MAX_LIVE_CAPTURE_DIMENSION ||
    source.height > USER_BROWSER_MAX_LIVE_CAPTURE_DIMENSION ||
    source.width * source.height > USER_BROWSER_MAX_LIVE_CAPTURE_PIXELS
  ) {
    throw new Error("Browser live capture exceeded its pixel bound");
  }

  const scale = Math.min(
    1,
    USER_BROWSER_MAX_LIVE_FRAME_WIDTH / source.width,
    USER_BROWSER_MAX_LIVE_FRAME_HEIGHT / source.height,
  );
  if (scale < 1) {
    image = image.resize({
      width: Math.max(1, Math.floor(source.width * scale)),
      height: Math.max(1, Math.floor(source.height * scale)),
    });
  }
  if (image.isEmpty()) throw new Error("Browser live capture resize failed");
  const output = image.getSize();
  if (
    !validDimension(output.width) ||
    !validDimension(output.height) ||
    output.width > USER_BROWSER_MAX_LIVE_FRAME_WIDTH ||
    output.height > USER_BROWSER_MAX_LIVE_FRAME_HEIGHT
  ) {
    throw new Error("Browser live capture resize exceeded its output bound");
  }
  const jpeg = image.toJPEG(70);
  if (jpeg.length === 0 || jpeg.length > USER_BROWSER_MAX_LIVE_FRAME_BYTES) {
    throw new Error("Browser live capture exceeded its output size bound");
  }
  return {
    data: jpeg.toString("base64"),
    width: output.width,
    height: output.height,
  };
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
