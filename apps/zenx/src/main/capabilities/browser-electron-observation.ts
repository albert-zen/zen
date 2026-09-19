import type { NativeImage } from "electron";
import type { BrowserLiveObservationListener } from "./browser-provider.js";

/** At most one in-flight capture; no files, observation ids, or browser input. */
export function observeElectronPage(
  port: {
    capture(): Promise<NativeImage>;
    current(): number | undefined;
  },
  listener: BrowserLiveObservationListener,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const send: BrowserLiveObservationListener = (event) => {
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
    message: "Connecting to this thread's Browser page.",
  });
  const capture = async () => {
    if (stopped) return;
    const version = port.current();
    if (version === undefined) {
      send({
        type: "status",
        status: "unavailable",
        message: "This Browser page has closed.",
      });
      stop();
      return;
    }
    try {
      let image = await port.capture();
      if (stopped) return;
      if (version !== port.current()) {
        send({
          type: "status",
          status: "connecting",
          message: "Waiting for the current Browser document.",
        });
      } else {
        if (image.isEmpty())
          throw new Error(
            "The Browser page has no image yet. Inspect or navigate the page again.",
          );
        const size = image.getSize();
        const scale = Math.min(1, 1600 / size.width, 1000 / size.height);
        if (scale < 1)
          image = image.resize({
            width: Math.max(1, Math.floor(size.width * scale)),
            height: Math.max(1, Math.floor(size.height * scale)),
          });
        const data = image.toJPEG(70);
        if (data.length > 4 * 1024 * 1024)
          throw new Error("Browser preview exceeds the frame size limit.");
        send({
          type: "status",
          status: "live",
          message: "Live view of the Agent's Browser page.",
        });
        send({
          type: "frame",
          frame: {
            sequence: ++sequence,
            mimeType: "image/jpeg",
            data: data.toString("base64"),
            ...image.getSize(),
          },
        });
      }
      if (!stopped) {
        timer = setTimeout(() => void capture(), 500);
        timer.unref();
      }
    } catch (error) {
      send({
        type: "status",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      stop();
    }
  };
  void capture();
  return stop;
}
