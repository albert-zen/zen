import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWindowsGuardDiagnostic,
  type GuardReportFile,
} from "./windows-foreground-input-diagnostic.js";

// Smoke-only evidence. This is never a provider, permission or product input path.
type Phase = "ready" | "edge" | "stop" | "escape";
type Report = {
  kind: "windows-os-routed-input";
  phase: Phase;
  guardPid: number;
  samples: number;
  sampledFocusChanges: number;
  foregroundEvents: number[];
  injectedClicks: number;
  guardMouseDown: number;
  guardMouseUp: number;
  injectedEscapeEvents?: number;
};

export function validateNativeProbeReport(
  value: unknown,
  phase: Phase,
): asserts value is Report {
  assert.ok(value && typeof value === "object");
  const report = value as Report;
  assert.equal(report.kind, "windows-os-routed-input");
  assert.equal(report.phase, phase);
  assert.ok(Number.isSafeInteger(report.guardPid) && report.guardPid > 0);
  assert.ok(Number.isSafeInteger(report.samples) && report.samples > 0);
  assert.equal(
    report.sampledFocusChanges,
    0,
    "external guard lost foreground during native input",
  );
  assert.deepEqual(
    report.foregroundEvents,
    [],
    "native foreground event observed a different window",
  );
  assert.equal(
    report.injectedClicks,
    phase === "ready" ? 1 : phase === "edge" ? 2 : 3,
  );
  assert.equal(report.guardMouseDown, phase === "ready" ? 1 : 2);
  assert.equal(report.guardMouseUp, phase === "ready" ? 1 : 2);
  if (phase === "escape") assert.equal(report.injectedEscapeEvents, 2);
}

export async function startWindowsForegroundInputProbe(
  options: {
    platform?: NodeJS.Platform;
    diagnosticDirectory?: string;
    spawnGuard?: (
      script: string,
      directory: string,
    ) => ReturnType<typeof spawn>;
  } = {},
) {
  assert.equal(options.platform ?? process.platform, "win32");
  const directory = await mkdtemp(join(tmpdir(), "zenx-overlay-native-"));
  const diagnostic = createWindowsGuardDiagnostic(directory);
  const script = join(directory, "guard.ps1");
  await writeFile(script, WINDOWS_FOREGROUND_GUARD);
  const child =
    options.spawnGuard?.(script, directory) ??
    spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-File", script, directory, String(process.pid)],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  diagnostic.mark("spawn-returned");
  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
    diagnostic.mark("spawned");
  });
  child.once("exit", () => diagnostic.mark("child-exit"));
  let error: Error | undefined;
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stderr = "";
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.once("error", (cause) => {
    diagnostic.mark(spawned ? "child-error" : "spawn-error");
    error = cause;
  });
  const settlement = new Promise<void>((resolve) =>
    child.once("close", (code, signal) => {
      diagnostic.mark("child-close");
      exitCode = code;
      exitSignal = signal;
      closed = true;
      resolve();
    }),
  );
  const read = async (name: string): Promise<unknown | undefined> => {
    try {
      return JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  };
  const report = async (
    name: GuardReportFile,
    phase: Phase,
  ): Promise<Report> => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const failure = await read("error.json");
      if (failure)
        throw new Error(`Native guard failed: ${JSON.stringify(failure)}`);
      const result = await read(name);
      if (result !== undefined) {
        diagnostic.mark("report-observed", name);
        validateNativeProbeReport(result, phase);
        assert.equal(
          result.guardPid,
          child.pid,
          "evidence must belong to the exact external guard process",
        );
        diagnostic.mark("report-validated", name);
        return result;
      }
      if (error || closed)
        throw (
          error ?? new Error(`Native guard closed before ${name}: ${stderr}`)
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    diagnostic.mark("report-timeout", name);
    throw new Error(`Timed out waiting for native guard ${name}: ${stderr}`);
  };
  const close = async (originalFailure?: unknown) => {
    const failures: unknown[] =
      originalFailure === undefined ? [] : [originalFailure];
    let forced = false;
    let killAccepted: boolean | null = null;
    if (!closed) {
      diagnostic.mark("close-requested");
      try {
        await writeFile(join(directory, "close"), "close");
        diagnostic.mark("close-written");
      } catch (cause) {
        diagnostic.mark("close-write-failed");
        failures.push(cause);
      }
    }
    await Promise.race([
      settlement,
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (!closed) {
      forced = true;
      diagnostic.mark("kill-requested");
      try {
        killAccepted = child.kill();
        diagnostic.mark("kill-returned");
      } catch (cause) {
        diagnostic.mark("kill-threw");
        failures.push(cause);
      }
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    if (!closed)
      failures.push(new Error("Native guard cleanup is unconfirmed"));
    if (forced)
      failures.push(new Error("Native guard required forced termination"));
    if (error && !failures.includes(error)) failures.push(error);
    if (closed && (exitCode !== 0 || exitSignal !== null)) {
      failures.push(
        new Error(
          `Native guard terminal status code=${String(exitCode)}, signal=${String(exitSignal)}; stderr: ${stderr}`,
        ),
      );
    }
    // A final phase report precedes shutdown. Inspect error evidence again after
    // the exact child closes; the native helper can fail with an ordinary exit.
    try {
      const failure = await read("error.json");
      if (failure !== undefined)
        failures.push(
          new Error(`Native guard error evidence: ${JSON.stringify(failure)}`),
        );
    } catch (cause) {
      failures.push(
        new Error("Could not read final native guard error evidence", {
          cause,
        }),
      );
    }
    if (failures.length > 0) {
      await diagnostic.retainFailure(
        options.diagnosticDirectory ??
          process.env.ZENX_NATIVE_GUARD_DIAGNOSTICS_DIR,
        {
          childPid: child.pid,
          closed,
          forced,
          killAccepted,
          exitCode,
          exitSignal,
          spawnError: error !== undefined && !spawned,
          childError: error !== undefined,
          stderrBytes,
        },
      );
      throw new AggregateError(
        failures,
        `Native guard failed: ${failures.map((cause) => String(cause)).join("; ")}; evidence retained at ${directory}`,
        { cause: originalFailure ?? failures[0] },
      );
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const ready = await report("ready.json", "ready");
    let escaped = false;
    return {
      ready,
      async clickEdge() {
        await writeFile(join(directory, "edge"), "one edge click");
        return report("edge.json", "edge");
      },
      async clickStop(point: { x: number; y: number }, windowHandle: Buffer) {
        const handle =
          windowHandle.length === 8
            ? windowHandle.readBigUInt64LE().toString()
            : String(windowHandle.readUInt32LE());
        await writeFile(
          join(directory, "stop.json.tmp"),
          JSON.stringify({ ...point, handle, pid: process.pid }),
        );
        await rename(
          join(directory, "stop.json.tmp"),
          join(directory, "stop.json"),
        );
        return report("stop-result.json", "stop");
      },
      async pressEscape() {
        await writeFile(
          join(directory, "escape"),
          "one OS-routed Escape key press",
        );
        const result = await report("escape-result.json", "escape");
        escaped = true;
        return result;
      },
      async finish() {
        await writeFile(join(directory, "finish"), "finish measured epoch");
        return report("final.json", escaped ? "escape" : "stop");
      },
      close,
    };
  } catch (cause) {
    await close(cause);
    throw cause;
  }
}

// One disposable external WinForms process, fixed file handshake, no refocusing
// during measurement. Source is packaged in the existing smoke JS bundle.
export const WINDOWS_FOREGROUND_GUARD = String.raw`param([string] $Directory, [int] $ParentPid)
$ErrorActionPreference = "Stop"
$diagnosticClock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-GuardStage([string] $Phase) {
  try {
    $line = '{{"phase":"{0}","pid":{1},"elapsedMs":{2}}}' -f $Phase,$PID,$diagnosticClock.ElapsedMilliseconds
    [System.IO.File]::AppendAllText([System.IO.Path]::Combine($Directory,"startup-stages.jsonl"),$line + [System.Environment]::NewLine)
  } catch { } # Observational only; never replace a guard result.
}
Write-GuardStage "script-entry"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
Write-GuardStage "assemblies-loaded"
Write-GuardStage "compile-start"
Add-Type -ReferencedAssemblies System,System.Drawing,System.Windows.Forms,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
public sealed class ZenXOverlayGuard : Form {
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
  delegate void EventProc(IntPtr hook,uint kind,IntPtr hwnd,int obj,int child,uint thread,uint time);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,EventProc callback,uint pid,uint thread,uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static string diagnosticDirectory;
  static Stopwatch diagnosticClock;
  static readonly List<string> diagnosticPhases = new List<string>();
  static void Stage(string phase) {
    try {
      if(diagnosticPhases.Contains(phase) || diagnosticPhases.Count>=32) return;
      diagnosticPhases.Add(phase);
      File.AppendAllText(Path.Combine(diagnosticDirectory,"startup-stages.jsonl"),
        "{\"phase\":\""+phase+"\",\"pid\":"+Process.GetCurrentProcess().Id+",\"elapsedMs\":"+diagnosticClock.ElapsedMilliseconds+"}\n");
    } catch { } // Diagnostic failure cannot change input or the original error.
  }
  readonly string directory; readonly int parentPid;
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  readonly List<int> transitions = new List<int>();
  readonly EventProc callback; IntPtr hook; IntPtr guard;
  volatile bool sampling; Thread sampler;
  int samples,focusChanges,down,up,clicks,state,escapeEvents;
  long changedAt; readonly Stopwatch clock = Stopwatch.StartNew();
  public static void Run(string directory,int parentPid,Stopwatch diagnostics) {
    diagnosticDirectory=directory; diagnosticClock=diagnostics; Stage("managed-entry");
    // Per-thread coordinate mode only; never change the desktop's DPI settings.
    if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("Per-monitor native coordinate context unavailable");
    Stage("dpi-ready");
    Application.EnableVisualStyles();
    using (var form=new ZenXOverlayGuard(directory,parentPid)) {
      Stage("form-constructed");
      // Match the existing native fixture: hidden helper startup can suppress
      // the first ShowWindow. All activation is before the measurement loop.
      form.Show(); form.Hide(); form.Show(); form.Activate();
      Stage("activation-finished"); Stage("message-loop-enter");
      Application.Run(form);
    }
    Stage("managed-return");
  }
  ZenXOverlayGuard(string directory,int parentPid) {
    this.directory=directory; this.parentPid=parentPid;
    callback=OnForeground;
    FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false;
    Text="ZenX owned external OS-input guard";
    var bounds=Screen.PrimaryScreen.Bounds;
    StartPosition=FormStartPosition.Manual;
    Bounds=new Rectangle(bounds.Left, bounds.Top+Math.Max(100,bounds.Height/2-100),320,200);
    BackColor=Color.FromArgb(40,65,90);
    MouseDown+=(s,e)=>{down++;}; MouseUp+=(s,e)=>{up++; Invalidate();};
    Paint+=(s,e)=>e.Graphics.DrawString("Owned native input guard: "+up,Font,Brushes.White,30,80);
    Shown+=(s,e)=>{guard=Handle;Stage("form-shown");};
    timer.Interval=10; timer.Tick+=(s,e)=>Tick(); timer.Start();
    FormClosed+=(s,e)=>{Stage("form-closed");sampling=false; if(hook!=IntPtr.Zero) UnhookWinEvent(hook); if(sampler!=null) sampler.Join(1000); timer.Dispose();Stage("form-cleanup-complete");};
  }
  bool Has(string name) { return File.Exists(Path.Combine(directory,name)); }
  void Save(string name,object value) {
    var target=Path.Combine(directory,name); var temp=target+".tmp";
    File.WriteAllText(temp,Json.Serialize(value)); File.Move(temp,target);
  }
  void OnForeground(IntPtr hook,uint kind,IntPtr hwnd,int obj,int child,uint thread,uint time) {
    if(sampling && hwnd!=guard) { uint pid; GetWindowThreadProcessId(hwnd,out pid); if(transitions.Count<256) transitions.Add((int)pid); else focusChanges++; }
  }
  object Evidence(string phase) { return new { kind="windows-os-routed-input",phase,guardPid=Process.GetCurrentProcess().Id,samples=Volatile.Read(ref samples),sampledFocusChanges=Volatile.Read(ref focusChanges),foregroundEvents=transitions.ToArray(),injectedClicks=clicks,guardMouseDown=down,guardMouseUp=up,injectedEscapeEvents=escapeEvents }; }
  void InjectClick(int x,int y) {
    if(GetForegroundWindow()!=guard) throw new Exception("Guard is not foreground before native click");
    int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
    if(vw<2 || vh<2 || x<vx || y<vy || x>=vx+vw || y>=vy+vh) throw new Exception("Native point outside virtual desktop");
    var inputs=new Input[3];
    inputs[0].Data.Mouse.X=(int)Math.Round((x-vx)*65535.0/(vw-1));
    inputs[0].Data.Mouse.Y=(int)Math.Round((y-vy)*65535.0/(vh-1));
    inputs[0].Data.Mouse.Flags=0x0001|0x8000|0x4000;
    inputs[1].Data.Mouse.Flags=0x0002; inputs[2].Data.Mouse.Flags=0x0004;
    if(SendInput(3,inputs,Marshal.SizeOf(typeof(Input)))!=3) throw new Exception("Native SendInput did not insert all three events");
    clicks++; changedAt=clock.ElapsedMilliseconds;
  }
  void InjectEscape() {
    if(GetForegroundWindow()!=guard) throw new Exception("Guard is not foreground before Escape");
    var inputs=new Input[2];
    inputs[0].Type=1; inputs[0].Data.Keyboard.Key=0x1B;
    inputs[1].Type=1; inputs[1].Data.Keyboard.Key=0x1B; inputs[1].Data.Keyboard.Flags=0x0002;
    if(SendInput(2,inputs,Marshal.SizeOf(typeof(Input)))!=2) throw new Exception("Native Escape injection did not insert both events");
    escapeEvents+=2; changedAt=clock.ElapsedMilliseconds;
  }
  void Tick() {
    try {
      Stage("first-tick");
      if(Has("close")) { Stage("close-observed");Close(); return; }
      using(var parent=Process.GetProcessById(parentPid)) if(parent.HasExited) { Close(); return; }
      if(clock.ElapsedMilliseconds>30000) throw new Exception("Native guard epoch deadline exceeded");
      if(state==0) {
        if(guard==IntPtr.Zero || GetForegroundWindow()!=guard) return;
        Stage("foreground-confirmed");
        hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0); // EVENT_SYSTEM_FOREGROUND, out-of-context
        if(hook==IntPtr.Zero) throw new Exception("Native foreground hook unavailable");
        sampling=true;
        sampler=new Thread(()=>{while(sampling){Interlocked.Increment(ref samples);if(GetForegroundWindow()!=guard)Interlocked.Increment(ref focusChanges);Thread.Sleep(5);}});
        sampler.IsBackground=true; sampler.Start();
        InjectClick(Left+8,Top+60); Stage("self-click-injected");state=1; return;
      }
      if(state==1 && down==1 && up==1) Stage("self-click-received");
      if(state==1 && down==1 && up==1 && clock.ElapsedMilliseconds-changedAt>=150) { Save("ready.json",Evidence("ready"));Stage("ready-written");state=2; }
      else if(state==2 && Has("edge")) { InjectClick(Left+8,Top+60); state=3; }
      else if(state==3 && down==2 && up==2 && clock.ElapsedMilliseconds-changedAt>=150) { Save("edge.json",Evidence("edge"));state=4; }
      else if(state==4 && Has("stop.json")) {
        var request=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(directory,"stop.json")));
        var handle=new IntPtr(long.Parse((string)request["handle"])); uint pid; GetWindowThreadProcessId(handle,out pid);
        if(pid!=(uint)parentPid || Convert.ToInt32(request["pid"])!=parentPid || !IsWindowVisible(handle)) throw new Exception("Stop window is not the owned visible Electron window");
        int x=Convert.ToInt32(request["x"]),y=Convert.ToInt32(request["y"]);Rect rect;
        if(!GetWindowRect(handle,out rect) || x<rect.Left || y<rect.Top || x>=rect.Right || y>=rect.Bottom) throw new Exception("Stop point is outside the exact owned window");
        InjectClick(x,y);state=5;
      }
      else if(state==5 && clock.ElapsedMilliseconds-changedAt>=250) { Save("stop-result.json",Evidence("stop"));state=6; }
      else if(state==6 && Has("escape")) { InjectEscape();state=9; }
      else if(state==9 && clock.ElapsedMilliseconds-changedAt>=250) { Save("escape-result.json",Evidence("escape"));state=10; }
      else if(state==10 && Has("finish")) { changedAt=clock.ElapsedMilliseconds;state=11; }
      else if(state==11 && clock.ElapsedMilliseconds-changedAt>=150) { Save("final.json",Evidence("escape"));state=12; }
      else if(state==6 && Has("finish")) { changedAt=clock.ElapsedMilliseconds;state=7; }
      else if(state==7 && clock.ElapsedMilliseconds-changedAt>=150) { Save("final.json",Evidence("stop"));state=8; }
    } catch(Exception error) { Stage("guard-error");if(!Has("error.json")) Save("error.json",new {error=error.Message});Close(); }
  }
}
'@
Write-GuardStage "compiled"
[ZenXOverlayGuard]::Run($Directory,$ParentPid,$diagnosticClock)
Write-GuardStage "script-return"
`;
