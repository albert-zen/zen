/** Disposable native fixture, embedded so the packaged smoke never reads the checkout. */
export const WINDOWS_PACKAGED_UIA_FIXTURE = String.raw`
param([string]$Mode, [string]$Directory, [string]$Title, [int]$TargetPid = 0, [string]$TargetHwnd = "0")
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class ZenXPackagedFixture {
  public static string DirectoryPath;
  public static string FilePath(string name) { return Path.Combine(DirectoryPath, name); }
  public static void Write(string name, string value) {
    string destination = FilePath(name), temporary = destination + "." + Guid.NewGuid().ToString("N");
    File.WriteAllText(temporary, value, new UTF8Encoding(false));
    if (File.Exists(destination)) File.Replace(temporary, destination, null);
    else File.Move(temporary, destination);
  }
  public static void Json(string name, object value) { Write(name, new JavaScriptSerializer().Serialize(value)); }
  public static bool Exists(string name) { return File.Exists(FilePath(name)); }
  public static void Run(string mode, string directory, string title, int targetPid, string targetHwnd) {
    DirectoryPath = directory;
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
    Application.EnableVisualStyles();
    if (mode == "target") Target(title);
    else if (mode == "guard") new Guard(targetPid, new IntPtr(Int64.Parse(targetHwnd))).Run();
    else throw new InvalidOperationException("Unknown fixture role");
  }
  public sealed class BlockingEditor : TextBox {
    protected override void WndProc(ref Message message) {
      // A real ValuePattern.SetValue must enter the native edit operation. This
      // blocking target belongs only to the fixture; production has no test hook.
      if (message.Msg == 0x000C && Exists("block-value") && !Exists("value-entered")) {
        Write("value-entered", "WM_SETTEXT");
        var timeout = Stopwatch.StartNew();
        while (!Exists("release-value") && timeout.ElapsedMilliseconds < 30000) Thread.Sleep(5);
        if (!Exists("release-value")) Write("value-block-timeout", "timeout");
      }
      base.WndProc(ref message);
    }
  }
  static BlockingEditor Editor(Form form) {
    var editor = new BlockingEditor();
    editor.Name = "ZenXPackagedEditor";
    editor.AccessibleName = "ZenX packaged editor";
    editor.Multiline = true;
    editor.SetBounds(24, 24, 550, 120);
    form.Controls.Add(editor);
    return editor;
  }
  static void Target(string title) {
    var form = new Form();
    form.Text = title; form.SetBounds(40, 40, 620, 320); form.StartPosition = FormStartPosition.Manual;
    BlockingEditor editor = Editor(form);
    var button = new Button();
    button.Name = "ZenXPackagedInvoke"; button.Text = "ZenX packaged invoke";
    button.SetBounds(24, 164, 190, 32);
    int invokeCount = 0;
    button.Click += delegate { Write("invoke-count", (++invokeCount).ToString()); };
    form.Controls.Add(button);
    // ToolStrip items are real, HWND-less UIA controls. The strict transport
    // must refuse to mutate one even when its provider offers InvokePattern.
    var strip = new ToolStrip(); strip.Dock = DockStyle.Bottom;
    var virtualButton = new ToolStripButton("ZenX virtual invoke");
    virtualButton.Name = "ZenXVirtualInvoke";
    virtualButton.Click += delegate { Write("virtual-invoked", "unexpected"); };
    strip.Items.Add(virtualButton); form.Controls.Add(strip);
    Write("invoke-count", "0");
    form.Show(); form.Hide(); form.Show();
    Json("target.json", new { pid = Process.GetCurrentProcess().Id, hwnd = form.Handle.ToInt64().ToString(), title = title, editorHwnd = editor.Handle.ToInt64().ToString(), buttonHwnd = button.Handle.ToInt64().ToString() });
    // WM_SETTEXT does not send EN_CHANGE for a multiline edit. Read the actual
    // target control on its own UI thread, independently of the UIA receipt.
    // null ensures the first observed empty value creates a real evidence file.
    string observedEditorValue = null;
    bool replaced = false, duplicated = false;
    Form duplicate = null;
    var lifetime = Stopwatch.StartNew();
    var timer = new System.Windows.Forms.Timer(); timer.Interval = 10;
    timer.Tick += delegate {
      string currentEditorValue = editor.Text;
      if (!string.Equals(observedEditorValue, currentEditorValue, StringComparison.Ordinal)) {
        Write("editor-value", currentEditorValue);
        observedEditorValue = currentEditorValue;
      }
      if (Exists("replace-editor") && !replaced) {
        replaced = true; string old = editor.Handle.ToInt64().ToString();
        // Keep the old HWND alive until the replacement obtains a different one.
        var replacement = Editor(form); string current = replacement.Handle.ToInt64().ToString();
        form.Controls.Remove(editor); editor.Dispose(); editor = replacement;
        Json("editor-replaced.json", new { oldHwnd = old, hwnd = current });
      }
      if (Exists("duplicate-root") && !duplicated) {
        duplicated = true; duplicate = new Form(); duplicate.Text = title;
        duplicate.SetBounds(750, 450, 260, 140); duplicate.StartPosition = FormStartPosition.Manual;
        // Never show/activate the duplicate during the focus epoch. Create the
        // ambiguous root only after the successful foreground report is saved.
        duplicate.Show();
        Json("root-duplicated.json", new { hwnd = duplicate.Handle.ToInt64().ToString() });
      }
      if (Exists("quit") || lifetime.ElapsedMilliseconds > 150000) {
        if (duplicate != null) duplicate.Close(); form.Close();
      }
    };
    timer.Start(); Application.Run(form); timer.Dispose();
  }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  delegate void WinEvent(IntPtr hook, uint eventId, IntPtr hwnd, int objectId, int childId, uint threadId, uint eventTime);
  sealed class Guard {
    readonly int targetPid; readonly IntPtr targetHwnd;
    readonly object gate = new object(); readonly List<object> transitions = new List<object>();
    readonly Stopwatch epoch = new Stopwatch();
    IntPtr guardHwnd, hook; Point initial; WinEvent callback; Thread sampler;
    bool recording, stop, overflow; int samples, focusChanges, pointerChanges, eventCount;
    public Guard(int pid, IntPtr hwnd) { targetPid = pid; targetHwnd = hwnd; }
    void Observe(string source, IntPtr foreground) {
      uint pid; GetWindowThreadProcessId(foreground, out pid);
      if (foreground != guardHwnd) focusChanges++;
      if (transitions.Count >= 8192) { overflow = true; return; }
      transitions.Add(new { source = source, elapsedMs = epoch.ElapsedMilliseconds, hwnd = foreground.ToInt64().ToString(), pid = pid, kind = foreground == guardHwnd ? "guard" : foreground == targetHwnd ? "target" : foreground == IntPtr.Zero ? "none" : "other" });
    }
    void Sample() {
      IntPtr previous = new IntPtr(-1);
      while (true) {
        lock (gate) {
          if (stop) return;
          samples++; IntPtr foreground = GetForegroundWindow();
          if (foreground != previous) { Observe("sample", foreground); previous = foreground; }
          else if (foreground != guardHwnd) focusChanges++;
          Point current;
          if (!GetCursorPos(out current) || current.X != initial.X || current.Y != initial.Y) pointerChanges++;
        }
        Thread.Sleep(5);
      }
    }
    public void Run() {
      var form = new Form(); form.Text = "ZenX independent foreground guard";
      form.SetBounds(720, 40, 450, 300); form.StartPosition = FormStartPosition.Manual;
      var editor = new TextBox(); editor.Text = "Independent user's foreground window"; editor.Dock = DockStyle.Fill;
      form.Controls.Add(editor);
      callback = delegate(IntPtr h, uint id, IntPtr hwnd, int obj, int child, uint tid, uint when) {
        lock (gate) { if (recording) { eventCount++; Observe("EVENT_SYSTEM_FOREGROUND", hwnd); } }
      };
      // OUTOFCONTEXT, with no SKIPOWNPROCESS: record every delivered foreground event.
      hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
      if (hook == IntPtr.Zero) throw new InvalidOperationException("EVENT_SYSTEM_FOREGROUND hook unavailable");
      form.Show(); form.Hide(); form.Show(); form.Activate(); editor.Focus();
      guardHwnd = form.Handle;
      var setup = Stopwatch.StartNew(); long stopAt = -1;
      var timer = new System.Windows.Forms.Timer(); timer.Interval = 10;
      timer.Tick += delegate {
        if (!recording && !stop && setup.ElapsedMilliseconds >= 500 && Exists("arm-guard")) {
          if (GetForegroundWindow() != guardHwnd) throw new InvalidOperationException("Independent guard did not acquire foreground during setup");
          uint pid; GetWindowThreadProcessId(guardHwnd, out pid);
          if (pid == targetPid || targetPid == Process.GetCurrentProcess().Id) throw new InvalidOperationException("Guard and target must be independent processes");
          if (!GetCursorPos(out initial)) throw new InvalidOperationException("Initial pointer unavailable");
          lock (gate) { recording = true; epoch.Start(); Observe("initial", guardHwnd); }
          sampler = new Thread(Sample); sampler.IsBackground = true; sampler.Start();
          Json("guard-ready.json", new { pid = Process.GetCurrentProcess().Id, hwnd = guardHwnd.ToInt64().ToString(), targetPid = targetPid, hookInstalled = true });
        }
        if (recording && Exists("stop-guard")) {
          if (stopAt < 0) stopAt = epoch.ElapsedMilliseconds;
          // Drain queued WinEvents while retaining samples and never restoring focus.
          if (epoch.ElapsedMilliseconds - stopAt >= 200) {
            lock (gate) { stop = true; recording = false; }
            sampler.Join();
            Json("guard-result.json", new { guardPid = Process.GetCurrentProcess().Id, targetPid = targetPid, hookInstalled = hook != IntPtr.Zero, samples = samples, eventCount = eventCount, focusChanges = focusChanges, pointerChanges = pointerChanges, overflow = overflow, elapsedMs = epoch.ElapsedMilliseconds, foregroundTransitions = transitions.ToArray() });
          }
        }
        if (Exists("quit") || setup.ElapsedMilliseconds > 150000) form.Close();
      };
      try { timer.Start(); Application.Run(form); }
      finally { lock (gate) { stop = true; recording = false; } if (sampler != null) sampler.Join(); timer.Dispose(); UnhookWinEvent(hook); GC.KeepAlive(callback); }
    }
  }
}
'@
  [ZenXPackagedFixture]::Run($Mode, $Directory, $Title, $TargetPid, $TargetHwnd)
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;
