import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAC_ACCESSIBILITY_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

test(
  "window discovery supplements missing AX with unique current-user CG windows, retaining AX precedence",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_ACCESSIBILITY_SOURCE.indexOf(
        "func discoveryProcessIdentity(",
      ),
      end = MAC_ACCESSIBILITY_SOURCE.indexOf(
        "let data = FileHandle.standardInput",
        start,
      );
    assert.ok(
      start > 0 && end > start,
      "CG readonly discovery projection must exist",
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-window-discovery-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "fixture.swift"),
      binary = path.join(directory, "fixture");
    await writeFile(
      source,
      `import AppKit\nimport ApplicationServices\nimport Foundation\nimport Darwin\n` +
        MAC_ACCESSIBILITY_SOURCE.slice(start, end) +
        `
let pid=getpid()
func row(_ title:String?,_ id:Int=123)->[String:Any] {
 var r:[String:Any]=[kCGWindowOwnerPID as String:NSNumber(value:pid),kCGWindowNumber as String:id,kCGWindowLayer as String:0,kCGWindowBounds as String:CGRect(x:-80,y:10,width:800,height:600).dictionaryRepresentation]
 if let title=title{r[kCGWindowName as String]=title};return r
}
let own=row("Owned discovery unique")
guard let target=discoveryCGTarget(own) else {fatalError("own target missing") }
precondition(target["pid"] as? Int==Int(pid));precondition(target["windowTitle"] as? String=="Owned discovery unique")
precondition(target["bundleId"]==nil,"bare native executable must omit bundle")
precondition(discoveryCGTarget(row(nil))==nil)
precondition(discoveryCGTarget(row(""))==nil)
precondition(discoveryCGTarget(row("bad",0))==nil)
var bad=own;bad.removeValue(forKey:kCGWindowBounds as String);precondition(discoveryCGTarget(bad)==nil)
bad=own;bad[kCGWindowOwnerPID as String]=Int32.max;precondition(discoveryCGTarget(bad)==nil)
bad=own;bad[kCGWindowLayer as String]=1;precondition(discoveryCGTarget(bad)==nil)
precondition(supplementWindowTargets([], [target], "UNIQUE").count==1)
precondition(supplementWindowTargets([], [target], "no match").isEmpty)
precondition(supplementWindowTargets([], [target,target], nil).isEmpty,"same PID/title is ambiguous")
let ax:[String:Any]=["pid":Int(pid),"windowTitle":"Owned discovery unique","applicationName":"AX preferred"]
let merged=supplementWindowTargets([ax],[target],nil)
precondition(merged.count==1&&merged[0]["applicationName"] as? String=="AX preferred")
precondition(supplementWindowTargets([ax],[],nil).count==1)
print("PASS unique-CG AX-precedence query ambiguity nilbundle invalid-owned-rows")
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
    assert.match(await runProcess(binary, [], 10000), /PASS unique-CG/);
  },
);
