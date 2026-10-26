import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const fixture = await readFile(
  new URL("../src/main/windows-packaged-uia-fixture.ts", import.meta.url),
  "utf8",
);
const observer = fixture.slice(
  fixture.indexOf("  public sealed class TargetDiagnostic"),
  fixture.indexOf("  static void Target("),
);

test("fixture UI observations are atomic-only and the bounded writer is off the UI thread", () => {
  const callbacks = observer.slice(
    observer.indexOf("public void Tick()"),
    observer.indexOf("public object Snapshot()"),
  );
  assert.doesNotMatch(
    callbacks,
    /Console|Json\(|Write\(|Sleep|Join|lock\s*\(/u,
  );
  assert.match(observer, /writer = new Thread/u);
  assert.match(observer, /count < 151/u);
  assert.match(observer, /writer\.IsBackground = true/u);
  assert.match(observer, /writer\.Join\(500\)/u);
  const dispatch = observer.slice(
    observer.indexOf("protected override void WndProc"),
  );
  assert.match(
    dispatch,
    /try \{ base\.WndProc\(ref message\); \}\s*finally \{ diagnostic\.Exit\(\); \}/u,
  );
  assert.doesNotMatch(
    dispatch,
    /message\.(?:Result|Msg|LParam|WParam)\s*=|catch|Console|File\.|Sleep|Join|lock\s*\(/u,
  );
});

test(
  "actual C# observer preserves dispatch and never waits for its blocked diagnostic writer",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-uia-diagnostic-test-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Compile the actual observer against a synthetic message dispatcher and a
    // deliberately blocked pipe writer. This is not native UIA acceptance.
    const source = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
public struct Message { public int Msg; public IntPtr LParam; public int Result; }
public class Form {
  public static int Calls; public static bool Throw;
  public void Dispatch(ref Message message) { WndProc(ref message); }
  protected virtual void WndProc(ref Message message) {
    Calls++; message.Result = 37;
    if (Throw) throw new InvalidOperationException("synthetic dispatch failure");
  }
}
static class Console { public static TextWriter Error = new BlockedWriter(); }
sealed class BlockedWriter : StringWriter {
  public override void WriteLine(string value) { Contract.Entered.Set(); Contract.Release.WaitOne(); }
}
public static class Contract {
  public static ManualResetEvent Entered = new ManualResetEvent(false), Release = new ManualResetEvent(false);
  ${observer}
  static long Number(object snapshot, string name) { return Convert.ToInt64(snapshot.GetType().GetProperty(name).GetValue(snapshot, null)); }
  public static void Run() {
    var probe = new TargetDiagnostic();
    try {
      probe.Start();
      if (!Entered.WaitOne(5000)) throw new Exception("Background writer never entered");
      probe.Tick();
      var form = new ObservedForm(probe);
      var message = new Message { Msg = 0x003D, LParam = new IntPtr(-25) };
      form.Dispatch(ref message);
      if (Form.Calls != 1 || message.Result != 37) throw new Exception("Original dispatch/result changed");
      Form.Throw = true; message.LParam = new IntPtr(-4);
      bool threw = false;
      try { form.Dispatch(ref message); } catch (InvalidOperationException) { threw = true; }
      if (!threw || Form.Calls != 2) throw new Exception("Original exception swallowed or dispatch repeated");
      var snapshot = probe.Snapshot();
      if (Number(snapshot, "ticks") != 1 || Number(snapshot, "getObjectEntered") != 2 || Number(snapshot, "getObjectExited") != 2 || Number(snapshot, "objectKind") != -4) throw new Exception("Atomic observations lost");
      Form.Throw = false; message.Msg = 0x000F; form.Dispatch(ref message);
      if (Form.Calls != 3 || Number(probe.Snapshot(), "getObjectEntered") != 2) throw new Exception("Unrelated message changed");
    } finally { Release.Set(); probe.Dispose(); }
  }
}`;
    const script = path.join(directory, "contract.ps1");
    await writeFile(
      script,
      `$ErrorActionPreference = "Stop"\nAdd-Type -ReferencedAssemblies System,System.Core,System.Web.Extensions -TypeDefinition @'\n${source}\n'@\n[Contract]::Run()\n`,
      "utf8",
    );
    await promisify(execFile)(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
      { timeout: 30000, windowsHide: true },
    );
  },
);
