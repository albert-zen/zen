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

function Write-Json($Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $utf8) }
function Open-SharedTextReader($Path) {
  # ReadAllText defaults to FileShare.Read and can block the live Node append
  # writer on Windows. Observation must permit writes without retrying them.
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { return [IO.StreamReader]::new($stream) }
  catch { $stream.Dispose(); throw }
}
function Read-SharedText($Path) {
  $reader = Open-SharedTextReader $Path
  try { return $reader.ReadToEnd() }
  finally { $reader.Dispose() }
}
function Read-Events($Directory, $ProcessId) {
  $file = Join-Path $Directory "events-$ProcessId.jsonl"
  if (!(Test-Path -LiteralPath $file)) { return @() }
  # Ignore only an incomplete final append; every completed line must parse.
  $raw = Read-SharedText $file
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
function Get-EventUtcTime($Event) {
  # PowerShell 7 converts ISO JSON timestamps to DateTime. Do not stringify them:
  # DateTime.Parse(DateTime) can lose milliseconds through the culture formatter.
  return ([DateTime]$Event.at).ToUniversalTime()
}
function Get-OwnedProcessState($Process) {
  $state = @{ started = $null -ne $Process; pid = $null; hasExited = $null; exitCode = $null }
  if ($null -eq $Process) { return $state }
  try {
    $state.pid = $Process.Id
    $Process.Refresh()
    $state.hasExited = $Process.HasExited
    if ($state.hasExited) { $state.exitCode = $Process.ExitCode }
  } catch { $state.observationError = $_.Exception.Message }
  return $state
}
function Write-FixtureDiagnostics($Directory, $Process) {
  foreach ($name in @("events-$($Process.Id).jsonl", "stdout.log", "stderr.log")) {
    try {
      $file = Join-Path $Directory $name
      if (!(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      $text = Read-SharedText $file
      if ($text.Length -gt 32768) { $text = "[last 32768 characters]`n" + $text.Substring($text.Length - 32768) }
      Write-Host "--- Startup failure diagnostics: $name"
      Write-Host $text
    } catch { Write-Warning "Could not print $name`: $($_.Exception.Message)" }
  }
}
function Assert-SoleVisibleWindow($ProcessId, [IntPtr] $Handle) {
  $visible = @([StartupWindows]::Visible($ProcessId))
  if ($visible.Count -ne 1 -or $visible[0] -ne $Handle.ToInt64() -or [StartupWindows]::IsIconic($Handle)) {
    throw "Expected the original sole, visible, non-minimized physical window"
  }
}
function Assert-RendererPresentation($Result) {
  $proof = $Result.presentation
  if ($null -eq $proof -or $proof.source -ne "frame-subscription" -or $proof.width -le 0 -or $proof.height -le 0) { throw "Renderer has no accepted presentation frame" }
  $selectors = @(".new-thread-action", ".settings-nav-row")
  if (@($proof.controls).Count -ne $selectors.Count) { throw "Renderer presentation is missing product controls" }
  for ($index = 0; $index -lt $selectors.Count; $index++) {
    $control = $proof.controls[$index]
    if ($control.selector -ne $selectors[$index] -or $control.textPresent -ne $true -or $control.contrast -lt 24 -or $control.contrastingPixels -lt 8) { throw "Renderer product control has no visible text/pixel evidence" }
  }
}
function Stop-Fixture($Process, $Directory) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  $errors = @()
  try { [IO.File]::WriteAllText((Join-Path $Directory "quit"), "quit", $utf8) }
  catch { $errors += "Quit signal: $($_.Exception.Message)" }
  $exited = $false
  try { $exited = $Process.WaitForExit(15000) }
  catch { $errors += "Owned PID $($Process.Id) graceful wait: $($_.Exception.Message)" }
  if (!$exited) {
    try {
      & taskkill /PID $Process.Id /T /F | Out-Null
      if ($LASTEXITCODE -ne 0) { $errors += "taskkill exited with $LASTEXITCODE for owned PID $($Process.Id)" }
    } catch { $errors += "Owned PID $($Process.Id) taskkill: $($_.Exception.Message)" }
    try {
      if (!$Process.WaitForExit(5000)) { $errors += "Owned PID $($Process.Id) is still running after taskkill" }
    } catch { $errors += "Owned PID $($Process.Id) final wait: $($_.Exception.Message)" }
  }
  if ($errors.Count) { throw ($errors -join "; ") }
}
function Stop-OwnedFixtures($Processes, $Directory) {
  foreach ($owned in $Processes) {
    try { Stop-Fixture $owned $Directory }
    catch { $_.Exception.Message }
  }
}
$runFailure = $null
$finalizationErrors = @()
try {
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
    $sample = @{ mode = $mode; passed = $false; targetMilliseconds = 1000; firstVisibleMilliseconds = $null; withinOneSecond = $null; focus = "not-observed" }
    $scenarioFailure = $null
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
      if ($visible.Count -eq 0) { throw "No native visible HWND was observed before timeout" }
      $sample.firstVisibleMilliseconds = [math]::Round(([DateTime]::UtcNow - $primary.StartTime.ToUniversalTime()).TotalMilliseconds, 1)
      $sample.processStartedAt = $primary.StartTime.ToUniversalTime().ToString("o")
      $sample.withinOneSecond = $sample.firstVisibleMilliseconds -le 1000
      if ($visible.Count -ne 1) { throw "Expected one visible native window, observed $($visible.Count)" }
      $hwnd = [IntPtr]::new($visible[0])
      $sample.hwnd = $hwnd.ToInt64().ToString()
      $startup = Wait-Event $directory $primary "startup-loaded"
      $gate = Wait-Event $directory $primary "gate-entered"
      if ($startup.hwnd -ne $sample.hwnd -or $startup.windowsCreated -ne 1 -or $startup.role -ne "status") { throw "Startup is not the sole visible physical window" }
      if ([string]::IsNullOrWhiteSpace($startup.text)) { throw "Startup status has no visible text" }
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
      $gateEnteredAt = Get-EventUtcTime $gate
      $sample.gateEnteredAt = $gateEnteredAt.ToString("o")
      $holdUntil = $gateEnteredAt.AddSeconds(3)
      while ([DateTime]::UtcNow -lt $holdUntil) { Start-Sleep -Milliseconds 20 }
      Assert-SoleVisibleWindow $primary.Id $hwnd
      $sample.visibleDuringDelayedBootstrap = $true
      $sample.gateReleaseRequestedAt = [DateTime]::UtcNow.ToString("o")
      [IO.File]::WriteAllText((Join-Path $directory "release"), "release", $utf8)
      $released = Wait-Event $directory $primary "gate-released"
      $gateReleasedAt = Get-EventUtcTime $released
      $sample.gateReleasedAt = $gateReleasedAt.ToString("o")
      $sample.gateHeldMilliseconds = ($gateReleasedAt - $gateEnteredAt).TotalMilliseconds
      if ($sample.gateHeldMilliseconds -lt 3000) { throw "Actual bootstrap gate was held for less than three seconds" }
      $type = if ($mode -eq "success") { "renderer-loaded" } else { "failure-loaded" }
      $result = Wait-Event $directory $primary $type
      Assert-SoleVisibleWindow $primary.Id $hwnd
      if ($result.hwnd -ne $sample.hwnd -or $result.windowsCreated -ne 1 -or ![StartupWindows]::IsWindowVisible($hwnd)) { throw "Completion did not retain the same visible physical window" }
      if ($mode -eq "success" -and $result.hostStatus -ne "ready") { throw "Real Host startup was not ready: $($result.hostStatus)" }
      if ($mode -eq "success") { Assert-RendererPresentation $result }
      if ($mode -eq "failure" -and ($result.role -ne "alert" -or !$result.text.Contains("Synthetic startup acceptance failure <inert> & visible"))) { throw "Actual bootstrap failure is not visible as inert error text" }
      $sample.result = $result
      $sample.passed = $true
    } catch {
      $scenarioFailure = $_
      $sample.error = $_.Exception.Message
      $sample.secondaryAtFailure = Get-OwnedProcessState $secondary
    } finally {
      $sample.cleanupErrors = @(Stop-OwnedFixtures @($secondary, $primary) $directory)
      # Windows keeps redirected output files locked until the child exits.
      if ($null -ne $scenarioFailure) { Write-FixtureDiagnostics $directory $primary }
      try { Write-Json (Join-Path $EvidenceDirectory "report.json") $report }
      catch { $sample.cleanupErrors += "Report write: $($_.Exception.Message)" }
      if ($sample.cleanupErrors.Count) { $sample.passed = $false }
    }
    if ($null -ne $scenarioFailure) { throw $scenarioFailure }
    if ($sample.cleanupErrors.Count) { throw ($sample.cleanupErrors -join "; ") }
  }
  $report.complete = $true
  $report.nativeSampleGaps = @($report.samples | ForEach-Object {
    if (!$_.withinOneSecond) { "$($_.mode): observed visibility exceeded the approximate 1000ms target" }
    if ($_.focus -ne "observed") { "$($_.mode): foreground focus was not observed; OS policy or regression remains unresolved" }
  })
} catch {
  $runFailure = $_
  $report.error = $_.Exception.Message
} finally {
  foreach ($key in $oldEnvironment.Keys) {
    try { [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key]) }
    catch { $finalizationErrors += "Restore environment $key`: $($_.Exception.Message)" }
  }
  try { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction Stop }
  catch { $finalizationErrors += "Remove temporary fixture: $($_.Exception.Message)" }
  $report.finalizationErrors = $finalizationErrors
  try { Write-Json (Join-Path $EvidenceDirectory "report.json") $report }
  catch { $finalizationErrors += "Final report write: $($_.Exception.Message)" }
  $report.finalizationErrors = $finalizationErrors
  # Console evidence remains available if the artifact file could not be written.
  try { $report | ConvertTo-Json -Depth 12 | Write-Host }
  catch { $finalizationErrors += "Console report: $($_.Exception.Message)" }
  foreach ($errorText in $finalizationErrors) { Write-Warning $errorText }
}
if ($null -ne $runFailure) { throw $runFailure }
if ($finalizationErrors.Count) { throw ($finalizationErrors -join "; ") }
