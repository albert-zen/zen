$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This smoke test must run on Windows."
}

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "WinApp CLI is missing. Install it with: winget install Microsoft.winappcli --source winget"
}

$fixture = $null
$fixtureScript = Join-Path $env:TEMP ("zenx-winapp-fixture-" + [guid]::NewGuid().ToString("N") + ".ps1")
$fixtureTitle = "ZenX WinApp 中文 Smoke " + [guid]::NewGuid().ToString("N")
$probeDirectory = Join-Path $env:TEMP ("zenx-background-probe-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $probeDirectory | Out-Null

try {
  @'
param([string] $Title, [string] $ProbeDirectory)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System,System.Drawing,System.Windows.Forms -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public class ZenXPartialPrintForm : System.Windows.Forms.Form {
  public bool PartialPrint;
  public string ProbePath;
  public int PrintCalls, PrintClientCalls;
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  public void WriteProbe() {
    File.WriteAllText(ProbePath, "{\"phase\":\"partial-print\",\"enabled\":" + (PartialPrint ? "true" : "false") + ",\"printCalls\":" + PrintCalls + ",\"printClientCalls\":" + PrintClientCalls + ",\"visible\":" + (IsWindowVisible(Handle) ? "true" : "false") + ",\"minimized\":" + (IsIconic(Handle) ? "true" : "false") + "}");
  }
  protected override void WndProc(ref System.Windows.Forms.Message message) {
    if (PartialPrint && (message.Msg==0x0317 || message.Msg==0x0318)) {
      if (message.Msg==0x0317) PrintCalls++; else PrintClientCalls++;
      using (var graphics=System.Drawing.Graphics.FromHdc(message.WParam))
        graphics.FillRectangle(System.Drawing.Brushes.White, 0, 0, 20, 20);
      WriteProbe();
      message.Result=new IntPtr(1);
      return;
    }
    base.WndProc(ref message);
  }
}
public static class ZenXCaptureSampler {
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, System.Text.StringBuilder text, int length);
  public static string ClassName(IntPtr hwnd) {
    var text = new System.Text.StringBuilder(256);
    if (GetClassNameW(hwnd, text, text.Capacity)==0) throw new InvalidOperationException("Fixture HWND class is unavailable");
    return text.ToString();
  }
  public static bool IsForeground(IntPtr hwnd) { return GetForegroundWindow()==hwnd; }
  public static void Start(IntPtr guard, IntPtr target, string directory, string epoch) {
    Point initial; GetCursorPos(out initial);
    var thread = new Thread(() => {
      int samples=0, focusChanges=0, pointerChanges=0, restored=0;
      bool minimized=false;
      var elapsed=System.Diagnostics.Stopwatch.StartNew();
      var transitions=new System.Collections.Generic.List<string>();
      var lastForeground=new IntPtr(-1);
      string phase="fixture-ready";
      File.WriteAllText(Path.Combine(directory, epoch + "-ready"), "ready");
      while (!File.Exists(Path.Combine(directory, epoch + "-stop"))) {
        samples++;
        var foreground=GetForegroundWindow();
        if (foreground != guard) focusChanges++;
        if (foreground != lastForeground) {
          try { phase=System.Text.RegularExpressions.Regex.Replace(File.ReadAllText(Path.Combine(directory,"phase")), "[^a-z-]", ""); } catch (IOException) { }
          uint pid; GetWindowThreadProcessId(foreground, out pid);
          string kind=foreground==guard ? "guard" : foreground==target ? "target" : foreground==IntPtr.Zero ? "none" : "other";
          if (transitions.Count<32) transitions.Add("{\"elapsedMs\":" + elapsed.ElapsedMilliseconds + ",\"phase\":\"" + phase + "\",\"foreground\":\"" + kind + "\",\"pid\":" + pid + "}");
          lastForeground=foreground;
        }
        Point current;
        if (!GetCursorPos(out current) || current.X != initial.X || current.Y != initial.Y) pointerChanges++;
        if (IsIconic(target)) minimized=true; else if (minimized) restored++;
        Thread.Sleep(5);
      }
      File.WriteAllText(Path.Combine(directory, epoch + "-result.json"), "{\"samples\":" + samples + ",\"focusChanges\":" + focusChanges + ",\"pointerChanges\":" + pointerChanges + ",\"restored\":" + restored + ",\"observedMinimized\":" + (minimized ? "true" : "false") + ",\"foregroundTransitions\":[" + string.Join(",",transitions) + "]}");
    });
    thread.IsBackground=true; thread.Start();
  }
}
"@
$form = New-Object ZenXPartialPrintForm
$form.ProbePath = Join-Path $ProbeDirectory "partial-print-probe.json"
$form.Text = $Title
$form.Width = 640
$form.Height = 360
$editor = New-Object System.Windows.Forms.TextBox
$editor.Name = "ZenXSmokeEditor"
$editor.AccessibleName = "ZenX smoke editor"
$editor.Multiline = $true
$editor.SetBounds(24, 24, 560, 220)
$form.Controls.Add($editor)
$marker = New-Object System.Windows.Forms.Panel
$marker.BackColor = [System.Drawing.Color]::FromArgb(25, 90, 210)
$marker.SetBounds(200, 260, 80, 25)
$form.Controls.Add($marker)
$magenta = New-Object System.Windows.Forms.Panel
$magenta.BackColor = [System.Drawing.Color]::Magenta
$magenta.SetBounds(300, 260, 25, 25)
$form.Controls.Add($magenta)
$button = New-Object System.Windows.Forms.Button
$button.Name = "ZenXSmokeButton"
$button.Text = "Probe Invoke"
$button.SetBounds(24, 260, 120, 25)
$script:invokeCount = 0
$button.add_Click({
  $script:invokeCount++
  Set-Content -LiteralPath (Join-Path $ProbeDirectory "invoke-count") -Value ([string]$script:invokeCount)
})
$form.Controls.Add($button)
# Two disposable native windows: the guard holds focus and occludes the target.
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(40, 40)
$guard = New-Object System.Windows.Forms.Form
$guard.Text = "ZenX Background Capture Guard"
$guard.Width = 420; $guard.Height = 260
$guard.StartPosition = "Manual"
$guard.Location = New-Object System.Drawing.Point(100, 100)
$guardEditor = New-Object System.Windows.Forms.TextBox
$guardEditor.Text = "User input stays here"
$guardEditor.Dock = "Fill"
$guard.Controls.Add($guardEditor)
# The hidden helper startup state can suppress the first ShowWindow call.
# Fully show the target before the guard takes focus and sampling starts.
$form.Show(); $form.Hide(); $form.Show()
$guard.Show(); $guard.Activate(); $guardEditor.Focus()
# Fixture-owned identities, never a selector fallback or production HWND contract.
@{
  pid = $PID
  started = ([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks).ToString()
  window = $form.Handle.ToInt64().ToString()
  guardWindow = $guard.Handle.ToInt64().ToString()
  editor = @{ hwnd = $editor.Handle.ToInt64().ToString(); className = [ZenXCaptureSampler]::ClassName($editor.Handle) }
  button = @{ hwnd = $button.Handle.ToInt64().ToString(); className = [ZenXCaptureSampler]::ClassName($button.Handle) }
  guard = @{ hwnd = $guardEditor.Handle.ToInt64().ToString(); className = [ZenXCaptureSampler]::ClassName($guardEditor.Handle) }
  unsupported = @{ hwnd = $marker.Handle.ToInt64().ToString(); className = [ZenXCaptureSampler]::ClassName($marker.Handle) }
} | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath (Join-Path $ProbeDirectory "semantic-fixture.json") -Encoding UTF8
Set-Content -LiteralPath (Join-Path $ProbeDirectory "invoke-count") -Value "0"
$script:semanticEpoch = ""
$script:semanticPending = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 25
$script:monitorStarted = $false
$script:captureSetupStarted = $false
$script:captureMonitorStarted = $false
$script:minimized = $false
$timer.add_Tick({
  if (-not $script:monitorStarted) {
    $script:monitorStarted = $true
    [ZenXCaptureSampler]::Start($guard.Handle, $form.Handle, $ProbeDirectory, "uia")
  }
  if (Test-Path (Join-Path $ProbeDirectory "semantic-setup")) {
    $requestedEpoch = (Get-Content -Raw -LiteralPath (Join-Path $ProbeDirectory "semantic-setup")).Trim()
    if ($requestedEpoch -in @("direct-default-value", "direct-no-focus-value", "direct-default-invoke", "direct-no-focus-invoke") -and $requestedEpoch -ne $script:semanticEpoch) {
      # Explicit preparation between independent epochs, never restoring focus inside an operation.
      $script:semanticEpoch = $requestedEpoch
      $script:semanticPending = $true
      $guard.Activate(); $guardEditor.Focus()
    }
  }
  if ($script:semanticPending -and [ZenXCaptureSampler]::IsForeground($guard.Handle)) {
    $script:semanticPending = $false
    [ZenXCaptureSampler]::Start($guard.Handle, $form.Handle, $ProbeDirectory, $script:semanticEpoch)
  }
  if (-not $script:captureSetupStarted -and (Test-Path (Join-Path $ProbeDirectory "capture-setup"))) {
    # Explicit fixture preparation, after the UIA epoch is saved and before any
    # screenshot. Never restore focus inside the capture measurement epoch.
    $script:captureSetupStarted = $true
    $guard.Activate(); $guardEditor.Focus()
  }
  if ($script:captureSetupStarted -and -not $script:captureMonitorStarted -and [ZenXCaptureSampler]::IsForeground($guard.Handle)) {
    $script:captureMonitorStarted = $true
    [ZenXCaptureSampler]::Start($guard.Handle, $form.Handle, $ProbeDirectory, "capture")
  }
  if (-not $form.PartialPrint -and (Test-Path (Join-Path $ProbeDirectory "unrendered"))) {
    $form.PartialPrint = $true
    $form.WriteProbe()
    Set-Content -LiteralPath (Join-Path $ProbeDirectory "unrendered-ready") -Value "ready"
  }
  if (-not $script:minimized -and (Test-Path (Join-Path $ProbeDirectory "minimize"))) {
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
    $script:minimized = $true
    Set-Content -LiteralPath (Join-Path $ProbeDirectory "minimized") -Value "ready"
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($guard)
'@ | Set-Content -LiteralPath $fixtureScript -Encoding UTF8
  $fixture = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-STA",
    "-File", ('"' + $fixtureScript + '"'),
    "-Title", ('"' + $fixtureTitle + '"'),
    "-ProbeDirectory", ('"' + $probeDirectory + '"')
  ) -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path (Join-Path $probeDirectory "uia-ready")) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path (Join-Path $probeDirectory "uia-ready"))) {
    throw "The deterministic two-window fixture did not become ready."
  }
  & node --import tsx ./src/main/windows-computer-smoke.ts --pid $fixture.Id --title $fixtureTitle --probe-directory $probeDirectory
  $smokeExit = $LASTEXITCODE
  $metrics = $null
  foreach ($epoch in @("uia", "direct-default-value", "direct-no-focus-value", "direct-default-invoke", "direct-no-focus-invoke", "capture")) {
    Set-Content -LiteralPath (Join-Path $probeDirectory ($epoch + "-stop")) -Value "stop"
    if (Test-Path (Join-Path $probeDirectory ($epoch + "-ready"))) {
      $resultPath = Join-Path $probeDirectory ($epoch + "-result.json")
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while (-not (Test-Path $resultPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
      $epochMetrics = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
      Write-Host ($epoch + " epoch native sampling: " + ($epochMetrics | ConvertTo-Json -Compress -Depth 4))
      if ($epoch -eq "capture") { $metrics = $epochMetrics }
    }
  }
  if ($smokeExit -ne 0) { throw "The ZenX WinApp adapter smoke failed with exit code $smokeExit." }
  if (-not $metrics -or $metrics.samples -lt 2 -or $metrics.focusChanges -ne 0 -or $metrics.pointerChanges -ne 0 -or $metrics.restored -ne 0 -or -not $metrics.observedMinimized) {
    throw ("Background capture disturbed the guard or restored the target: " + ($metrics | ConvertTo-Json -Compress))
  }
  Write-Host "Strict screenshot epoch passed continuous 5 ms native focus/pointer sampling. UIA targeting is separately observed, not certified focus-isolated."
} finally {
  if ($fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force }
  Remove-Item -LiteralPath $fixtureScript -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
