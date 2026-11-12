import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

test(
  "background metadata yields a plan and WindowServer image resolves on the native caller thread without fallback",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf(
        "enum NativeWindowCapturePlan",
      ),
      end = MAC_BOUND_TARGET_SOURCE.indexOf(
        "typealias WindowServerImageFunction",
        start,
      );
    assert.ok(
      start > 0 && end > start,
      "capture callback must publish a plan before native image resolution",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "zenx-capture-plan-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "fixture.swift"),
      binary = path.join(dir, "fixture");
    await writeFile(
      source,
      "import Foundation\nimport CoreGraphics\nvar progress:[Progress]=[]\nfunc captureProgress(_ value:Progress,_ requestId:String? = nil){progress.append(value)}\nenum Progress:Equatable{case planReady,completed}\n" +
        MAC_BOUND_TARGET_SOURCE.slice(start, end) +
        `
if #available(macOS 14.0, *) {
 let box=WindowCaptureResult()
 DispatchQueue.global().async {precondition(!Thread.isMainThread);box.finish(.success(.windowServer(width:8,height:4)))}
 let deadline=Date().addingTimeInterval(2)
 while box.read()==nil&&Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.002))}
 precondition(progress == [.planReady], "metadata must not announce a completed image")
 let plan=try box.read()!.get()
 let bitmap=CGContext(data:nil,width:8,height:4,bitsPerComponent:8,bytesPerRow:32,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
 var calls=0
 let image=try resolveNativeCapturePlan(plan) {width,height in precondition(Thread.isMainThread);precondition(width==8&&height==4);calls+=1;return bitmap}
 precondition(image.width==8&&image.height==4&&calls==1)
 _=try resolveNativeCapturePlan(.image(bitmap)){_,_ in fatalError("SCK image must not switch routes")}
 enum FixtureError:Error {case expected}
 do {_=try resolveNativeCapturePlan(plan){_,_ in calls+=1;throw FixtureError.expected};fatalError("failure must propagate")}catch FixtureError.expected{}
 precondition(calls==2,"a failed WindowServer call must not retry")
 print("PASS background-plan main-caller unchanged-dimensions no-fallback no-retry")
}
`,
    );
    await runProcess(
      "/usr/bin/swiftc",
      [
        "-O",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`,
        source,
        "-o",
        binary,
      ],
      60000,
    );
    assert.match(await runProcess(binary, [], 10000), /PASS background-plan/);
  },
);
