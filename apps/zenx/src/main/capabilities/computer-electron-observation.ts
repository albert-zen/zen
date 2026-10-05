import type { NativeImage } from "electron";

import type { ComputerLiveObservationListener } from "./computer-provider.js";

/** One cancellable capture at a time; frames are bounded and never persisted. */
export function observeComputerWindow(
  capture: () => Promise<
    | NativeImage
    | {
        image: NativeImage;
        windowWidth: number;
        windowHeight: number;
      }
  >,
  listener: ComputerLiveObservationListener,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let live = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const send: ComputerLiveObservationListener = (event) => {
    if (stopped) return;
    try {
      listener(event);
    } catch {
      stop();
    }
  };
  send({
    type: "status",
    status: "connecting",
    message: "Connecting to the selected Computer window.",
  });
  const next = async () => {
    if (stopped) return;
    try {
      const captured = await capture();
      let image = "image" in captured ? captured.image : captured;
      const geometry =
        "image" in captured
          ? {
              windowWidth: captured.windowWidth,
              windowHeight: captured.windowHeight,
            }
          : undefined;
      if (stopped) return;
      if (
        geometry &&
        (!Number.isFinite(geometry.windowWidth) ||
          geometry.windowWidth <= 0 ||
          !Number.isFinite(geometry.windowHeight) ||
          geometry.windowHeight <= 0)
      ) {
        throw new Error("The selected Computer window has invalid bounds");
      }
      if (image.isEmpty())
        throw new Error("The selected Computer window has no visible frame.");
      const size = image.getSize();
      const scale = Math.min(1, 1600 / size.width, 1000 / size.height);
      if (scale < 1)
        image = image.resize({
          width: Math.max(1, Math.floor(size.width * scale)),
          height: Math.max(1, Math.floor(size.height * scale)),
        });
      const data = image.toJPEG(70);
      if (data.byteLength > 4 * 1024 * 1024)
        throw new Error("Computer preview exceeds the frame size limit.");
      const capturedAt = new Date().toISOString();
      if (!live) {
        live = true;
        send({
          type: "status",
          status: "live",
          message: "Live window view.",
        });
      }
      send({
        type: "frame",
        frame: {
          sequence: ++sequence,
          mimeType: "image/jpeg",
          data: data.toString("base64"),
          ...image.getSize(),
          capturedAt,
          ...(geometry ?? {}),
        },
      });
      if (!stopped) {
        timer = setTimeout(() => void next(), 750);
        timer.unref();
      }
    } catch (error) {
      send({
        type: "status",
        status: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      stop();
    }
  };
  void next();
  return stop;
}
