/*
 * Adapted from T3 Code at 337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17.
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Disposable Node-mode entry. Native crashes and stalls cannot block Electron main.
import {
  APP_SHOT_MAX_PIXELS,
  APP_SHOT_MAX_PNG_BYTES,
  isAppShotBounds,
  isAppShotIdentity,
  isRecord,
} from "./app-shot-native-contract.js";

process.once("disconnect", () => process.exit(0));

async function run(): Promise<unknown> {
  const operation = process.argv[2];
  if (operation !== "foreground" && operation !== "region" && operation !== "accessibility")
    throw new Error("Invalid App Shot native operation");
  const request = new Promise<unknown>((resolve) => process.once("message", resolve));
  // Import only the native package needed for this operation, and only in this child.
  if (operation === "foreground") {
    if (process.platform !== "win32") throw new Error("Unsupported platform");
    const { loadAppShotWindowsApi, readAppShotWindowsForegroundWithApi } =
      await import("./app-shot-windows-foreground.js");
    const api = await loadAppShotWindowsApi();
    process.send?.("ready");
    await request;
    return readAppShotWindowsForegroundWithApi(api);
  }
  if (process.platform !== "win32" && process.platform !== "darwin")
    throw new Error("Unsupported platform");
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { default?: typeof imported }).default ?? imported;
  process.send?.("ready");
  const input = await request;
  if (!isRecord(input)) throw new Error("Invalid App Shot request");
  if (operation === "region") {
    if (process.platform !== "win32" || !isAppShotBounds(input.region) ||
        input.region.width * input.region.height > APP_SHOT_MAX_PIXELS)
      throw new Error("Invalid App Shot capture region");
    const shot = await xa11y.screenshot({ region: input.region });
    if (!Number.isSafeInteger(shot.width) || !Number.isSafeInteger(shot.height) ||
        shot.width <= 0 || shot.height <= 0 ||
        shot.width * shot.height > APP_SHOT_MAX_PIXELS)
      throw new Error("App Shot image exceeds the pixel budget");
    const png = shot.toPng();
    if (png.byteLength > APP_SHOT_MAX_PNG_BYTES)
      throw new Error("App Shot image exceeds the byte budget");
    return { width: shot.width, height: shot.height, png: png.toString("base64") };
  }
  if (!isAppShotIdentity(input.identity) || input.identity.platform !== process.platform)
    throw new Error("Invalid App Shot accessibility identity");
  const { readAppShotAccessibilityWithApi } = await import("./app-shot-accessibility.js");
  return readAppShotAccessibilityWithApi(xa11y.App, input.identity);
}

void run().then(
  (value) => process.send?.({ type: "result", value }),
  () => process.send?.({ type: "error" }),
);
