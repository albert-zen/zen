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
  "App desktop fence allows only target reordering behind all foreground windows while exact-window equality stays strict",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf("struct DesktopFence:"),
      end = MAC_BOUND_TARGET_SOURCE.indexOf("extension DesktopFence", start);
    assert.ok(
      start > 0 && end > start,
      "desktop snapshot comparison must be independently executable",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "zenx-app-fence-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "fixture.swift"),
      binary = path.join(dir, "fixture");
    await writeFile(
      source,
      "import Foundation\nimport CoreGraphics\n" +
        MAC_BOUND_TARGET_SOURCE.slice(start, end) +
        `
func snapshot(_ order:[Int],_ owners:[Int:pid_t]?=nil,_ foreground:pid_t=10,_ pointer:CGPoint=CGPoint(x:2,y:3),_ asleep:Bool=false,_ locked:Bool=false,_ console:Bool=true,_ loginWindow:Bool=false,_ complete:Bool=true)->DesktopFence {
 let defaults:[Int:pid_t]=[1:10,2:10,3:30,4:40,5:30,6:30]
 return DesktopFence(foreground:foreground,pointer:pointer,displayAsleep:asleep,windows:order,windowOwners:owners ?? defaults.filter{order.contains($0.key)},consoleLocked:locked,onConsole:console,foregroundIsLoginWindow:loginWindow,metadataComplete:complete)
}
let above=snapshot([3,1,2,4]),behind=snapshot([1,2,3,4]),bottom=snapshot([1,2,4,3])
precondition(behind.allowsApplicationInput(from:above,targetPID:30),"own above to below foreground is allowed")
precondition(behind.allowsApplicationInput(from:bottom,targetPID:30),"own bottom to directly behind foreground is allowed")
precondition(!(above==behind ) && !(bottom==behind),"old exact-window equality must reject every own reorder")
precondition(!snapshot([1,3,2,4]).allowsApplicationInput(from:behind,targetPID:30),"must be behind every foreground window")
precondition(!above.allowsApplicationInput(from:behind,targetPID:30),"must never cover foreground")
precondition(snapshot([1,2,5,3,4]).allowsApplicationInput(from:behind,targetPID:30),"own additional window behind foreground remains app scope")
precondition(snapshot([1,2,4]).allowsApplicationInput(from:behind,targetPID:30),"closed own window does not revoke app identity")
precondition(!snapshot([2,1,3,4]).allowsApplicationInput(from:behind,targetPID:30),"foreign reorder refused")
precondition(!snapshot([1,2,3]).allowsApplicationInput(from:behind,targetPID:30),"lost foreign refused")
precondition(!snapshot([1,2,3,4,7],[1:10,2:10,3:30,4:40,7:50]).allowsApplicationInput(from:behind,targetPID:30),"new foreign refused")
precondition(!snapshot([1,2,3,4],[1:10,2:10,3:30,4:50]).allowsApplicationInput(from:behind,targetPID:30),"foreign owner replacement refused")
precondition(!snapshot([1,2,3,4],[1:10,2:10,4:40]).allowsApplicationInput(from:behind,targetPID:30),"unknown owner refused")
precondition(!snapshot([1,2,3,4],nil,11).allowsApplicationInput(from:behind,targetPID:30))
precondition(!snapshot([1,2,3,4],nil,10,CGPoint(x:3,y:3)).allowsApplicationInput(from:behind,targetPID:30))
precondition(!snapshot([1,2,3,4],nil,10,CGPoint(x:2,y:3),true).allowsApplicationInput(from:behind,targetPID:30))
precondition(!snapshot([1,2,3,4],nil,10,CGPoint(x:2,y:3),false,true).allowsApplicationInput(from:behind,targetPID:30))
precondition(!snapshot([1,2,3,4],nil,10,CGPoint(x:2,y:3),false,false,false).allowsApplicationInput(from:behind,targetPID:30))
let locked=snapshot([3,4],[3:30,4:40],99,CGPoint(x:2,y:3),false,true,true,true)
precondition(snapshot([4,3],[3:30,4:40],99,CGPoint(x:2,y:3),false,true,true,true).allowsApplicationInput(from:locked,targetPID:30),"locked known console without foreground layer0 window permits own reorder")
precondition(!snapshot([4,3],[3:30,4:40],99,CGPoint(x:2,y:3),false,true,true,false).allowsApplicationInput(from:locked,targetPID:30),"locked fake loginwindow bundle refused")
let activeNoFront=snapshot([3,4],[3:30,4:40],99)
precondition(!activeNoFront.allowsApplicationInput(from:activeNoFront,targetPID:30),"active unknown foreground window scope refused")
let selfFront=snapshot([3,4,5],[3:30,4:40,5:30],30)
precondition(snapshot([5,4,3],[3:30,4:40,5:30],30).allowsApplicationInput(from:selfFront,targetPID:30))
precondition(snapshot([1,2,3,4],[1:10,2:10,3:30,4:50])==behind,"new owner metadata does not alter original four-field window equality")
precondition(snapshot([1,2,3,4],nil,10,CGPoint(x:2,y:3),false,false,true,true)==behind,"extra foreground bundle metadata does not alter old equality")

let rawGood:[[String:Any]] = behind.windows.map { [kCGWindowNumber as String:$0,kCGWindowOwnerPID as String:behind.windowOwners[$0]!] }
let goodProjection=projectAppWindowRows(rawGood)
precondition(goodProjection.metadataComplete && goodProjection.windows==behind.windows && goodProjection.owners==behind.windowOwners)
func rawSnapshot(_ rows:[[String:Any]])->DesktopFence {
 let projection=projectAppWindowRows(rows)
 return snapshot(projection.windows,projection.owners,10,CGPoint(x:2,y:3),false,false,true,false,projection.metadataComplete)
}
let invalidRows:[[String:Any]] = [[:],[kCGWindowNumber as String:7],[kCGWindowOwnerPID as String:70],[kCGWindowNumber as String:0,kCGWindowOwnerPID as String:70],[kCGWindowNumber as String:-7,kCGWindowOwnerPID as String:70],[kCGWindowNumber as String:7,kCGWindowOwnerPID as String:0],[kCGWindowNumber as String:7,kCGWindowOwnerPID as String:-70],rawGood[0]]
for row in invalidRows {
 let projection=projectAppWindowRows(rawGood+[row])
 precondition(!projection.metadataComplete,"raw row cannot disappear into an apparently complete App snapshot")
 let invalid=rawSnapshot(rawGood+[row])
 precondition(!invalid.matchesApplicationContext(from:behind,targetPID:30))
 precondition(!behind.matchesApplicationContext(from:invalid,targetPID:30))
}
let missingBoth=rawSnapshot(rawGood+[[:]])
precondition(missingBoth.windows==behind.windows && missingBoth.windowOwners==behind.windowOwners,"regression must exercise row information lost by compactMap")
precondition(missingBoth==behind,"legacy four-field equality remains unchanged by App metadata completeness")
precondition(!missingBoth.metadataComplete)
print("PASS own-behind foreign-identity/order global-console strict-old-window raw-metadata-complete")
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
    assert.match(await runProcess(binary, [], 10000), /PASS own-behind/);
  },
);
