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
  protected override void WndProc(ref System.Windows.Forms.Message message) {
    if (PartialPrint && (message.Msg==0x0317 || message.Msg==0x0318)) {
      using (var graphics=System.Drawing.Graphics.FromHdc(message.WParam))
        graphics.FillRectangle(System.Drawing.Brushes.White, 0, 0, 20, 20);
      message.Result=new IntPtr(1);
      return;
    }
    base.WndProc(ref message);
  }
}
public static class ZenXCaptureSampler {
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  public static void Start(IntPtr guard, IntPtr target, string directory) {
    Point initial; GetCursorPos(out initial);
    var thread = new Thread(() => {
      int samples=0, focusChanges=0, pointerChanges=0, restored=0;
      bool minimized=false;
      File.WriteAllText(Path.Combine(directory, "ready"), "ready");
      while (!File.Exists(Path.Combine(directory, "stop"))) {
        samples++;
        if (GetForegroundWindow() != guard) focusChanges++;
        Point current;
        if (!GetCursorPos(out current) || current.X != initial.X || current.Y != initial.Y) pointerChanges++;
        if (IsIconic(target)) minimized=true; else if (minimized) restored++;
        Thread.Sleep(5);
      }
      File.WriteAllText(Path.Combine(directory, "result.json"), "{\"samples\":" + samples + ",\"focusChanges\":" + focusChanges + ",\"pointerChanges\":" + pointerChanges + ",\"restored\":" + restored + ",\"observedMinimized\":" + (minimized ? "true" : "false") + "}");
    });
    thread.IsBackground=true; thread.Start();
  }
}
"@
$form = New-Object ZenXPartialPrintForm
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
$form.Show(); $guard.Show(); $guard.Activate(); $guardEditor.Focus()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 25
$script:monitorStarted = $false
$script:minimized = $false
$timer.add_Tick({
  if (-not $script:monitorStarted) {
    $script:monitorStarted = $true
    [ZenXCaptureSampler]::Start($guard.Handle, $form.Handle, $ProbeDirectory)
  }
  if (-not $form.PartialPrint -and (Test-Path (Join-Path $ProbeDirectory "unrendered"))) {
    $form.PartialPrint = $true
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
  while (-not (Test-Path (Join-Path $probeDirectory "ready")) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path (Join-Path $probeDirectory "ready"))) {
    throw "The deterministic two-window fixture did not become ready."
  }
  & node --import tsx ./src/main/windows-computer-smoke.ts --pid $fixture.Id --title $fixtureTitle --probe-directory $probeDirectory
  $smokeExit = $LASTEXITCODE
  Set-Content -LiteralPath (Join-Path $probeDirectory "stop") -Value "stop"
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not (Test-Path (Join-Path $probeDirectory "result.json")) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $metrics = Get-Content -Raw -LiteralPath (Join-Path $probeDirectory "result.json") | ConvertFrom-Json
  if ($smokeExit -ne 0) { throw "The ZenX WinApp adapter smoke failed with exit code $smokeExit." }
  if ($metrics.samples -lt 2 -or $metrics.focusChanges -ne 0 -or $metrics.pointerChanges -ne 0 -or $metrics.restored -ne 0 -or -not $metrics.observedMinimized) {
    throw ("Background capture disturbed the guard or restored the target: " + ($metrics | ConvertTo-Json -Compress))
  }
  Write-Host ("Continuous 5 ms native focus/pointer sampling passed: " + ($metrics | ConvertTo-Json -Compress))
} finally {
  if ($fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force }
  Remove-Item -LiteralPath $fixtureScript -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
