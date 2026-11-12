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
  "native exact-window image preserves black/sRGB geometry but rejects transparent or mismatched pixels",
  { skip: process.platform !== "darwin", timeout: 90_000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf(
        "func normalizeWindowServerImage(",
      ),
      end = MAC_BOUND_TARGET_SOURCE.indexOf(
        "func captureWindowServerImage(",
        start,
      );
    assert.ok(
      start > 0 && end > start,
      "native exact-window image validation is present",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-window-image-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "fixture.swift"),
      binary = path.join(directory, "fixture");
    await writeFile(
      source,
      `import Foundation\nimport CoreGraphics\nstruct TargetError:Error{let message:String}\nfunc refuse(_ message:String)throws->Never{throw TargetError(message:message)}\n` +
        MAC_BOUND_TARGET_SOURCE.slice(start, end) +
        `
func bitmap(_ opaque:Bool,_ colored:Bool)->CGImage {
 let c=CGContext(data:nil,width:8,height:4,bitsPerComponent:8,bytesPerRow:32,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue|CGBitmapInfo.byteOrder32Big.rawValue)!
 if opaque {c.setFillColor(CGColor(red:0,green:0,blue:0,alpha:1));c.fill(CGRect(x:0,y:0,width:8,height:4))}
 if colored {c.setFillColor(CGColor(red:1,green:0,blue:0,alpha:1));c.fill(CGRect(x:0,y:0,width:4,height:4));c.setFillColor(CGColor(red:0,green:0,blue:1,alpha:1));c.fill(CGRect(x:0,y:2,width:4,height:2))}
 return c.makeImage()!
}
let black=try normalizeWindowServerImage(bitmap(true,false),8,4)
precondition(black.width==8&&black.height==4)
let pattern=bitmap(true,true),normal=try normalizeWindowServerImage(pattern,8,4)
precondition((pattern.dataProvider!.data! as Data)==(normal.dataProvider!.data! as Data),"normalization must not flip, resize or recolor sRGB pixels")
do{_ = try normalizeWindowServerImage(bitmap(false,false),8,4);fatalError("transparent image incorrectly accepted")}catch let e as TargetError{precondition(e.message.contains("transparent"))}
do{_ = try normalizeWindowServerImage(pattern,9,4);fatalError("incoherent full frame incorrectly accepted")}catch let e as TargetError{precondition(e.message.contains("full-window"))}
print("PASS black-preserved pattern-unflipped transparent-refused geometry-refused")
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
      60_000,
    );
    assert.match(await runProcess(binary, [], 10_000), /PASS black-preserved/);
  },
);
