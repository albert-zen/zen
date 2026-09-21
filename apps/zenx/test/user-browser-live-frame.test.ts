import assert from "node:assert/strict";
import test from "node:test";

import {
  processUserBrowserLiveFrame,
  USER_BROWSER_MAX_LIVE_CAPTURE_BYTES,
  USER_BROWSER_MAX_LIVE_CAPTURE_PIXELS,
  type UserBrowserLiveImage,
} from "../src/main/capabilities/user-browser-live-frame.js";

class FakeImage implements UserBrowserLiveImage {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly encoded = Buffer.from("resized-frame"),
    private readonly resizeAdjustment = 0,
  ) {}

  isEmpty(): boolean {
    return false;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(options: { width: number; height: number }): UserBrowserLiveImage {
    return new FakeImage(
      options.width - this.resizeAdjustment,
      options.height - this.resizeAdjustment,
      this.encoded,
    );
  }

  toJPEG(): Buffer {
    return this.encoded;
  }
}

test("live Chrome frames resize locally and report the decoded output dimensions", async () => {
  const result = await processUserBrowserLiveFrame(
    Buffer.from("native-capture").toString("base64"),
    async () => new FakeImage(3_200, 1_800, Buffer.from("jpeg"), 1),
  );

  assert.deepEqual(result, {
    data: Buffer.from("jpeg").toString("base64"),
    width: 1_599,
    height: 899,
  });
});

test("live Chrome frame input byte and decoded pixel bounds are independent", async () => {
  let decoded = false;
  await assert.rejects(
    processUserBrowserLiveFrame(
      Buffer.alloc(USER_BROWSER_MAX_LIVE_CAPTURE_BYTES + 1).toString("base64"),
      async () => {
        decoded = true;
        return new FakeImage(1, 1);
      },
    ),
    /input size bound/u,
  );
  assert.equal(decoded, false);

  await assert.rejects(
    processUserBrowserLiveFrame(
      Buffer.from("small-input").toString("base64"),
      async () => new FakeImage(8_193, 8_193),
    ),
    /pixel bound/u,
  );
  assert.ok(8_193 * 8_193 > USER_BROWSER_MAX_LIVE_CAPTURE_PIXELS);
});
