param(
  [string] $PackageDirectory = (Join-Path $PSScriptRoot "../.packaged/artifact/ZenX-win32-x64"),
  [string] $EvidenceDirectory = (Join-Path $PSScriptRoot "../.packaged/startup-evidence")
)
$ErrorActionPreference = "Stop"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "Windows is required; no emulated timing result is supported." }
$PackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $PackageDirectory "ZenX.exe"))) { throw "Build the ordinary portable app first." }
# Evidence must be fresh, so a failed run cannot reuse a previous receipt.
if (Test-Path -LiteralPath $EvidenceDirectory) { throw "Choose a new evidence directory." }
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null
$EvidenceDirectory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$fixtureRoot = Join-Path $env:TEMP ("zenx-startup-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
$report = @{ environment = @{ os = [Environment]::OSVersion.VersionString; runner = $env:RUNNER_NAME; workflowCommit = $env:GITHUB_SHA; arch = $env:PROCESSOR_ARCHITECTURE }; instrumentedPackage = $true; samples = @(); complete = $false }
$oldEnvironment = @{}
foreach ($key in @("ZENX_DATA_DIR", "ELECTRON_RENDERER_URL", "ZENX_PROJECT_ACCEPTANCE_CONFIG", "ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG")) {
  $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key)
  [Environment]::SetEnvironmentVariable($key, $null)
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class StartupWindows {
  private delegate bool EnumCallback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  public static long[] Visible(uint pid) {
    var result = new List<long>();
    EnumWindows((hwnd, data) => { uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid && IsWindowVisible(hwnd)) result.Add(hwnd.ToInt64()); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
function Write-Json($Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $utf8) }
function Read-Events($Directory, $ProcessId) {
  $file = Join-Path $Directory "events-$ProcessId.jsonl"
  if (!(Test-Path -LiteralPath $file)) { return @() }
  # Ignore only an incomplete final append; every completed line must parse.
  $raw = [IO.File]::ReadAllText($file)
  $lines = $raw.Split("`n")
  for ($i = 0; $i -lt $lines.Length - 1; $i++) {
    if ($lines[$i].Trim()) { $lines[$i] | ConvertFrom-Json }
  }
}
function Wait-Event($Directory, $Process, $Type) {
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ([DateTime]::UtcNow -lt $deadline) {
    $events = @(Read-Events $Directory $Process.Id)
    $errorEvent = $events | Where-Object type -eq "fixture-error" | Select-Object -First 1
    if ($errorEvent) { throw $errorEvent.message }
    $match = $events | Where-Object type -eq $Type | Select-Object -First 1
    if ($match) { return $match }
    if ($Process.HasExited) { throw "Process exited before $Type, code $($Process.ExitCode)" }
    Start-Sleep -Milliseconds 20
  }
  throw "Timed out waiting for $Type"
}
function Stop-Fixture($Process, $Directory) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  [IO.File]::WriteAllText((Join-Path $Directory "quit"), "quit", $utf8)
  if (!$Process.WaitForExit(15000)) { & taskkill /PID $Process.Id /T /F | Out-Null }
}
try {
  foreach ($mode in @("success", "failure")) {
    $directory = Join-Path $EvidenceDirectory $mode
    New-Item -ItemType Directory -Path $directory | Out-Null
    $artifact = Join-Path $fixtureRoot $mode
    & node (Join-Path $PSScriptRoot "prepare-windows-startup-acceptance.mjs") $PackageDirectory $artifact $directory $mode
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare private startup fixture" }
    $userData = Join-Path $fixtureRoot "$mode-user"
    New-Item -ItemType Directory -Path $userData | Out-Null
    Write-Json (Join-Path $userData "host-profile.json") @{
      version = 1; onboardingComplete = $true; provider = @{ type = "fake"; displayName = "Local fixture" }
      defaultModel = "fake"; models = @("fake"); workspace = $null; workspaces = @(); lastUsedWorkspace = $null; approvalPolicy = "never"
    }
    $env:ZENX_DATA_DIR = Join-Path $fixtureRoot "$mode-data"
    $primary = $null
    $secondary = $null
    $sample = @{ mode = $mode; passed = $false; targetMilliseconds = 1000; focus = "not-observed" }
    $report.samples += $sample
    try {
      $executable = Join-Path $artifact "ZenX.exe"
      $arguments = @('--user-data-dir="' + $userData + '"')
      $primary = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $directory "stdout.log") -RedirectStandardError (Join-Path $directory "stderr.log")
      $deadline = [DateTime]::UtcNow.AddSeconds(30)
      $visible = @()
      while ([DateTime]::UtcNow -lt $deadline) {
        $visible = @([StartupWindows]::Visible($primary.Id))
        if ($visible.Count -gt 0) { break }
        if ($primary.HasExited) { throw "Process exited before a visible native window" }
        Start-Sleep -Milliseconds 20
      }
      $sample.firstVisibleMilliseconds = [math]::Round(([DateTime]::UtcNow - $primary.StartTime.ToUniversalTime()).TotalMilliseconds, 1)
      $sample.processStartedAt = $primary.StartTime.ToUniversalTime().ToString("o")
      $sample.withinOneSecond = $sample.firstVisibleMilliseconds -le 1000
      if ($visible.Count -ne 1) { throw "Expected one visible native window, observed $($visible.Count)" }
      $hwnd = [IntPtr]::new($visible[0])
      $sample.hwnd = $hwnd.ToInt64().ToString()
      $startup = Wait-Event $directory $primary "startup-loaded"
      $gate = Wait-Event $directory $primary "gate-entered"
      if ($startup.hwnd -ne $sample.hwnd -or $startup.windowsCreated -ne 1 -or $startup.role -ne "status") { throw "Startup is not the sole visible physical window" }
      $sample.startupText = $startup.text
      $sample.electron = (@(Read-Events $directory $primary.Id) | Where-Object type -eq "observer" | Select-Object -First 1).electron
      # Keep bootstrap held for a real native second launch, not a mocked event.
      [StartupWindows]::ShowWindow($hwnd, 6) | Out-Null
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while (![StartupWindows]::IsIconic($hwnd) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
      if (![StartupWindows]::IsIconic($hwnd)) { throw "Could not establish minimized precondition" }
      $sample.foregroundBeforeSecondLaunch = [StartupWindows]::GetForegroundWindow().ToInt64().ToString()
      $secondary = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
      $activation = Wait-Event $directory $primary "second-instance"
      if (!$secondary.WaitForExit(10000)) { throw "Second process did not exit after forwarding activation" }
      if ($secondary.ExitCode -ne 0) { throw "Second process exited with $($secondary.ExitCode)" }
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while ([DateTime]::UtcNow -lt $deadline) {
        if (![StartupWindows]::IsIconic($hwnd) -and [StartupWindows]::GetForegroundWindow() -eq $hwnd) { break }
        Start-Sleep -Milliseconds 20
      }
      $sample.foregroundAfterSecondLaunch = [StartupWindows]::GetForegroundWindow().ToInt64().ToString()
      $sample.focus = if ($sample.foregroundAfterSecondLaunch -eq $sample.hwnd) { "observed" } else { "unresolved" }
      if ([StartupWindows]::IsIconic($hwnd)) { throw "Second launch did not restore the minimized window" }
      if (@($activation.windows).Count -ne 1 -or $activation.windows[0].hwnd -ne $sample.hwnd) { throw "Second launch changed physical window identity" }
      if (@(Read-Events $directory $primary.Id | Where-Object type -eq "gate-released").Count) { throw "Bootstrap released before second-launch check" }
      # Deliberately slow bootstrap for at least three seconds after gate entry.
      $holdUntil = [DateTime]::Parse($gate.at).ToUniversalTime().AddSeconds(3)
      while ([DateTime]::UtcNow -lt $holdUntil) { Start-Sleep -Milliseconds 20 }
      $sample.visibleDuringDelayedBootstrap = [StartupWindows]::IsWindowVisible($hwnd)
      $sample.gateHeldMilliseconds = [math]::Round(([DateTime]::UtcNow - [DateTime]::Parse($gate.at).ToUniversalTime()).TotalMilliseconds, 1)
      [IO.File]::WriteAllText((Join-Path $directory "release"), "release", $utf8)
      $type = if ($mode -eq "success") { "renderer-loaded" } else { "failure-loaded" }
      $result = Wait-Event $directory $primary $type
      if ($result.hwnd -ne $sample.hwnd -or $result.windowsCreated -ne 1 -or ![StartupWindows]::IsWindowVisible($hwnd)) { throw "Completion did not retain the same visible physical window" }
      if ($mode -eq "success" -and $result.hostStatus -ne "ready") { throw "Real Host startup was not ready: $($result.hostStatus)" }
      if ($mode -eq "failure" -and ($result.role -ne "alert" -or !$result.text.Contains("Synthetic startup acceptance failure <inert> & visible"))) { throw "Actual bootstrap failure is not visible as inert error text" }
      $sample.result = $result
      $sample.passed = $true
    } catch {
      $sample.error = $_.Exception.Message
      throw
    } finally {
      Stop-Fixture $secondary $directory
      Stop-Fixture $primary $directory
      Write-Json (Join-Path $EvidenceDirectory "report.json") $report
    }
  }
  $report.complete = $true
  $report.nativeSampleGaps = @($report.samples | ForEach-Object {
    if (!$_.withinOneSecond) { "$($_.mode): observed visibility exceeded the approximate 1000ms target" }
    if ($_.focus -ne "observed") { "$($_.mode): foreground focus was not observed; OS policy or regression remains unresolved" }
  })
} finally {
  Write-Json (Join-Path $EvidenceDirectory "report.json") $report
  Get-Content -Raw -LiteralPath (Join-Path $EvidenceDirectory "report.json") | Write-Host
  foreach ($key in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key]) }
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
