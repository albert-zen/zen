import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const fixture = await readFile(
  new URL("../src/main/windows-packaged-uia-fixture.ts", import.meta.url),
  "utf8",
);
const smoke = await readFile(
  new URL("../src/main/windows-packaged-uia-smoke.ts", import.meta.url),
  "utf8",
);
const target = fixture.slice(
  fixture.indexOf("static void Target("),
  fixture.indexOf("[StructLayout(LayoutKind.Sequential)] struct Point"),
);
function registration() {
  const match = target.match(
    /form\.BeginInvoke\(new MethodInvoker\(delegate \{\s*if \(observation != null\) observation\.Mark\(AcquisitionObserver\.ReadyDispatched\);\s*Json\("target\.json",[^\n]+\);\s*\}\)\);/u,
  );
  assert.ok(
    match,
    "target readiness must be published by a dispatched UI callback",
  );
  return match[0];
}

test("target readiness is queued after setup and only published by a UI callback", () => {
  const queued = registration();
  assert.equal(target.match(/Json\("target\.json"/gu)?.length, 1);
  assert.match(queued, /messageLoopReady = true/u);
  assert.ok(
    target.indexOf("form.Show(); form.Hide(); form.Show();") <
      target.indexOf(queued),
  );
  assert.ok(target.indexOf(queued) < target.indexOf("Application.Run(form)"));
  assert.match(smoke, /assert\.equal\(target\.messageLoopReady, true\)/u);
  assert.ok(
    smoke.indexOf("assert.equal(target.messageLoopReady, true)") <
      smoke.indexOf('"guard",'),
  );
  assert.ok(
    smoke.indexOf("assert.equal(target.messageLoopReady, true)") <
      smoke.indexOf('"guard-ready.json"'),
  );
});

test(
  "actual C# readiness callback cannot publish while deterministic dispatcher is paused",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-uia-ready-test-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Compile the actual production registration, replacing only the Forms dispatcher
    // and file sink. This proves callback ordering, not native UIA availability.
    const source = `using System;
using System.Diagnostics;
delegate void MethodInvoker();
sealed class Dispatcher {
  public IntPtr Handle = new IntPtr(101);
  public MethodInvoker Pending;
  public void BeginInvoke(MethodInvoker callback) { Pending = callback; }
  public void Pump() { var callback = Pending; Pending = null; callback(); }
}
sealed class AcquisitionObserver {
  public const int ReadyDispatched = 1;
  public void Mark(int flag) {}
}
public static class ReadinessContract {
  static int writes;
  static object receipt;
  static void Json(string name, object value) {
    if (name != "target.json") throw new Exception("Unexpected receipt");
    writes++; receipt = value;
  }
  public static void Run() {
    var form = new Dispatcher(); var editor = new Dispatcher(); var button = new Dispatcher();
    AcquisitionObserver observation = null;
    string title = "synthetic readiness fixture";
    ${registration()}
    if (writes != 0 || form.Pending == null) throw new Exception("Ready escaped before dispatch");
    form.Pump();
    if (writes != 1 || form.Pending != null) throw new Exception("Ready was not published exactly once");
    if (!(bool)receipt.GetType().GetProperty("messageLoopReady").GetValue(receipt, null)) throw new Exception("Missing dispatch evidence");
  }
}`;
    const script = path.join(directory, "contract.ps1");
    await writeFile(
      script,
      `$ErrorActionPreference = "Stop"\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[ReadinessContract]::Run()\n`,
      "utf8",
    );
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
      { timeout: 30000, windowsHide: true },
    );
  },
);
