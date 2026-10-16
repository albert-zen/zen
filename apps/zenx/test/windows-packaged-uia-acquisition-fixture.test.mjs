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
const observer = fixture.slice(
  fixture.indexOf("  public sealed class AcquisitionObserver"),
  fixture.indexOf("  public sealed class BlockingEditor"),
);
const mark = observer.slice(
  observer.indexOf("    public void Mark("),
  observer.indexOf("    void Publish("),
);
const wndProc = observer.slice(
  observer.indexOf("    protected override void WndProc("),
);
const fields = [
  "schemaVersion",
  "readyDispatched",
  "messageLoopTickObserved",
  "uiaRootEntered",
  "uiaRootReturned",
  "uiaRootNonzero",
  "msaaClientEntered",
  "msaaClientReturned",
  "msaaClientNonzero",
  "otherEntered",
  "otherReturned",
  "otherNonzero",
  "observerFailed",
];

test("fixture observation is opt-in and limited to the disposable target root", () => {
  assert.match(
    fixture,
    /Environment\.GetEnvironmentVariable\("ZENX_UIA_ACQUISITION_DIAGNOSTIC"\) == "1" \? new AcquisitionObserver\(\) : null/u,
  );
  assert.equal(fixture.match(/new AcquisitionForm\(/gu)?.length, 1);
  assert.match(
    fixture,
    /Form form = observation == null \? new Form\(\) : new AcquisitionForm\(observation\)/u,
  );
  assert.match(
    fixture,
    /timer\.Tick \+= delegate \{\s*if \(observation != null\) observation\.Mark\(AcquisitionObserver\.MessageLoopTickObserved\)/u,
  );
  assert.match(
    fixture,
    /form\.BeginInvoke\(new MethodInvoker\(delegate \{\s*if \(observation != null\) observation\.Mark\(AcquisitionObserver\.ReadyDispatched\)/u,
  );
  assert.match(
    observer,
    /uint normalized = unchecked\(\(uint\)objectId\.ToInt64\(\)\)/u,
  );
  assert.match(observer, /normalized == unchecked\(\(uint\)-25\)/u);
  assert.match(observer, /normalized == unchecked\(\(uint\)-4\)/u);
  assert.doesNotMatch(
    observer,
    /SendMessage|PostMessage|AccessibleObject|AutomationElement|FromHandle|Console\.|Thread\.Sleep|\.Wait\(/u,
  );
});

test("UI observation only atomically marks flags and queues bounded background publication", () => {
  assert.match(
    mark,
    /if \(Add\(bits\) && !ThreadPool\.QueueUserWorkItem\(Publish\)\)/u,
  );
  assert.doesNotMatch(mark, /lock\s*\(|Json\(|File\.|Write\(|Console\./u);
  assert.match(
    observer,
    /lock \(publicationGate\) \{\s*\/\/[^\n]+\n\s*int snapshot = Interlocked\.CompareExchange\(ref flags, 0, 0\)/u,
  );
  assert.match(observer, /catch \{ Add\(ObserverFailed\); \}/u);
  assert.equal(wndProc.match(/base\.WndProc\(ref message\)/gu)?.length, 1);
  assert.doesNotMatch(
    wndProc.replace(/\/\/[^\n]*/gu, ""),
    /catch|finally|message\.Result\s*=/u,
  );
  assert.ok(
    wndProc.indexOf("observer.Mark(category)") <
      wndProc.indexOf("base.WndProc"),
  );
  assert.ok(
    wndProc.indexOf("base.WndProc") <
      wndProc.indexOf("observer.Mark((category << 1)"),
  );
  const snapshot = observer.slice(
    observer.indexOf('Json("uia-acquisition-fixture.json"'),
    observer.indexOf("          });"),
  );
  assert.deepEqual(
    [...snapshot.matchAll(/^\s+(\w+) =/gmu)].map((match) => match[1]),
    fields,
  );
  assert.match(
    fixture,
    /if \(File\.Exists\(destination\)\) File\.Replace\(temporary, destination, null\);/u,
  );
});

test(
  "actual C# observer seam: enum filtering, original exception, bounded async coherent snapshots (Windows compiler only; not native UIA evidence)",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-acquisition-seam-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    // The observer and WndProc below are verbatim production C#. Only Forms,
    // ThreadPool scheduling and the JSON sink are deterministic synthetic seams.
    const source = `using System;
using System.Collections.Generic;
using System.Threading;
public struct Message { public int Msg; public IntPtr LParam, Result; }
public class Form {
  public Exception Failure;
  public int Calls;
  public IntPtr ReturnValue;
  protected virtual void WndProc(ref Message message) {
    Calls++; if (Failure != null) throw Failure; message.Result = ReturnValue;
  }
  public void Dispatch(ref Message message) { WndProc(ref message); }
}
public static class ThreadPool {
  public static List<WaitCallback> Pending = new List<WaitCallback>();
  public static bool Fail;
  public static bool QueueUserWorkItem(WaitCallback callback) {
    if (Fail) throw new InvalidOperationException("Synthetic scheduler failure");
    Pending.Add(callback); return true;
  }
  public static void Drain() {
    while (Pending.Count != 0) {
      int last = Pending.Count - 1;
      var callback = Pending[last]; Pending.RemoveAt(last); callback(null);
    }
  }
}
public static class Contract {
  static List<object> receipts = new List<object>();
  static bool failSink;
  static void Json(string name, object value) {
    if (name != "uia-acquisition-fixture.json") throw new Exception("Unexpected name");
    if (failSink) throw new Exception("Synthetic sink failure");
    receipts.Add(value);
  }
${observer}
  static void Check(bool value, string message) { if (!value) throw new Exception(message); }
  static bool Flag(object value, string name) { return (bool)value.GetType().GetProperty(name).GetValue(value, null); }
  static object Last() { return receipts[receipts.Count - 1]; }
  public static void Run() {
    Check(AcquisitionObserver.Category(new IntPtr(-25)) == AcquisitionObserver.UiaRootEntered, "UIA category");
    Check(AcquisitionObserver.Category(new IntPtr(-4)) == AcquisitionObserver.MsaaClientEntered, "MSAA category");
    if (IntPtr.Size == 8) {
      Check(AcquisitionObserver.Category(new IntPtr(0xFFFFFFE7L)) == AcquisitionObserver.UiaRootEntered, "DWORD UIA");
      Check(AcquisitionObserver.Category(new IntPtr(0xFFFFFFFCL)) == AcquisitionObserver.MsaaClientEntered, "DWORD MSAA");
    }
    Check(AcquisitionObserver.Category(new IntPtr(123)) == AcquisitionObserver.OtherEntered, "Other category");
    var observer = new AcquisitionObserver(); var form = new AcquisitionForm(observer);
    var message = new Message { Msg = 0x000C, LParam = new IntPtr(-25) };
    form.Dispatch(ref message); Check(ThreadPool.Pending.Count == 0, "Non-WM_GETOBJECT observed");
    observer.Mark(AcquisitionObserver.ReadyDispatched);
    observer.Mark(AcquisitionObserver.MessageLoopTickObserved);
    form.ReturnValue = new IntPtr(42); message.Msg = 0x003D;
    form.Dispatch(ref message);
    Check(message.Result == new IntPtr(42), "Result altered");
    for (int i = 0; i < 100; i++) form.Dispatch(ref message);
    Check(ThreadPool.Pending.Count == 4 && receipts.Count == 0, "Unbounded queue or synchronous IO");
    ThreadPool.Drain();
    Check(Flag(Last(), "readyDispatched") && Flag(Last(), "messageLoopTickObserved"), "Readiness flags");
    Check(Flag(Last(), "uiaRootEntered") && Flag(Last(), "uiaRootReturned") && Flag(Last(), "uiaRootNonzero"), "UIA flags");
    form.ReturnValue = IntPtr.Zero; message.LParam = new IntPtr(-4); form.Dispatch(ref message); ThreadPool.Drain();
    Check(Flag(Last(), "msaaClientReturned") && !Flag(Last(), "msaaClientNonzero"), "Zero return");
    var original = new InvalidOperationException("Original provider failure"); form.Failure = original;
    message.LParam = new IntPtr(123); message.Result = new IntPtr(77);
    try { form.Dispatch(ref message); throw new Exception("Provider exception lost"); }
    catch (InvalidOperationException error) { Check(Object.ReferenceEquals(error, original), "Exception replaced"); }
    ThreadPool.Drain();
    Check(message.Result == new IntPtr(77) && Flag(Last(), "otherEntered") && !Flag(Last(), "otherReturned"), "Exception incorrectly returned");
    // A failed scheduler must not mask the very same provider exception.
    var failingObserver = new AcquisitionObserver(); var failingForm = new AcquisitionForm(failingObserver); failingForm.Failure = original;
    ThreadPool.Fail = true;
    try { failingForm.Dispatch(ref message); throw new Exception("Exception lost"); }
    catch (InvalidOperationException error) { Check(Object.ReferenceEquals(error, original), "Scheduler masked exception"); }
    ThreadPool.Fail = false;
    failingObserver.Mark(AcquisitionObserver.ReadyDispatched); ThreadPool.Drain();
    Check(Flag(Last(), "observerFailed"), "Scheduler failure not recorded");
    var sinkObserver = new AcquisitionObserver(); failSink = true;
    sinkObserver.Mark(AcquisitionObserver.ReadyDispatched); ThreadPool.Drain();
    failSink = false; sinkObserver.Mark(AcquisitionObserver.MessageLoopTickObserved); ThreadPool.Drain();
    Check(Flag(Last(), "observerFailed"), "Sink failure escaped or not recorded");
    // Every snapshot from the first observer is coherent and monotonic even when
    // queued callbacks execute newest-first. No numeric/native identity leaks.
    string[] names = new string[] { ${fields.map((field) => `"${field}"`).join(", ")} };
    object previous = null;
    foreach (object receipt in receipts.GetRange(0, receipts.Count - 2)) {
      Check(receipt.GetType().GetProperties().Length == names.Length, "Extra field");
      foreach (string name in names) {
        var property = receipt.GetType().GetProperty(name); Check(property != null, "Missing field");
        if (name == "schemaVersion") Check((int)property.GetValue(receipt, null) == 1, "Schema version");
        else { Check(property.PropertyType == typeof(bool), "Nonboolean field"); if (previous != null && Flag(previous, name)) Check(Flag(receipt, name), "Regressing snapshot"); }
      }
      previous = receipt;
    }
  }
}`;
    const script = path.join(directory, "contract.ps1");
    await writeFile(
      script,
      `$ErrorActionPreference = "Stop"\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[Contract]::Run()\n`,
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
