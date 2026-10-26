param([string] $HarnessPath)
$ErrorActionPreference = "Stop"
$diagnosticClock = [Diagnostics.Stopwatch]::StartNew()
function Write-Phase([string] $Phase) {
  [Console]::Error.WriteLine("StartupHarness phase={0} elapsedMs={1} utc={2:O}", $Phase, $diagnosticClock.ElapsedMilliseconds, [DateTime]::UtcNow)
}
Write-Phase "ast-load-start"
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
Write-Phase "ast-load-complete"
# Load only the real harness helpers. Never execute its package or process launcher.
foreach ($name in @("Assert-SoleVisibleWindow", "Stop-Fixture", "Stop-OwnedFixtures", "Get-EventUtcTime", "Get-OwnedProcessState", "Assert-RendererPresentation")) {
  $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($functions.Count -ne 1) { throw "Missing unique helper $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
Write-Phase "helpers-loaded"
Write-Phase "add-type-start"
Add-Type -TypeDefinition @'
using System;
public static class StartupWindows {
  public static long[] Handles = new long[] { 42 };
  public static bool Minimized = false;
  public static long[] Visible(uint pid) { return Handles; }
  public static bool IsIconic(IntPtr hwnd) { return Minimized; }
}
'@
Write-Phase "add-type-complete"
Write-Phase "assertions-start"
function Assert-True($Value, $Message) { if (!$Value) { throw $Message } }
function Assert-Throws([scriptblock] $Action, $Pattern) {
  $caught = $null
  try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
  if ($null -eq $caught -or $caught -notmatch $Pattern) { throw "Expected $Pattern; received $caught" }
}
$missing = Get-OwnedProcessState $null
Assert-True (!$missing.started -and $null -eq $missing.hasExited) "An unstarted secondary must not be reported as exited"
$observed = [pscustomobject]@{ Id = 321; HasExited = $false; Refreshes = 0 }
$observed | Add-Member ScriptMethod Refresh { $this.Refreshes++ }
$observed | Add-Member ScriptProperty ExitCode { throw "A live process has no exit code" }
$running = Get-OwnedProcessState $observed
Assert-True ($running.started -and $running.pid -eq 321 -and !$running.hasExited -and $null -eq $running.exitCode -and !$running.ContainsKey("observationError")) "A live secondary must remain live with no exit code"
$observed.HasExited = $true
$observed | Add-Member ScriptProperty ExitCode { return 17 } -Force
$exited = Get-OwnedProcessState $observed
Assert-True ($exited.hasExited -and $exited.exitCode -eq 17 -and $observed.Refreshes -eq 2) "An exited secondary must retain its real exit code"
$observed | Add-Member ScriptMethod Refresh { throw "Synthetic process observation failure" } -Force
$unknown = Get-OwnedProcessState $observed
Assert-True ($null -eq $unknown.hasExited -and $unknown.observationError -match "Synthetic process observation failure") "Observation failure must remain unknown without throwing over the scenario failure"
# Modern ConvertFrom-Json may materialize dates; older versions leave strings.
# Both must preserve the exact fractional timestamp used for holding bootstrap.
$expected = [DateTimeOffset]::Parse("2026-10-12T14:59:19.846Z").UtcDateTime
foreach ($event in @(
  ('{"at":"2026-10-12T14:59:19.846Z"}' | ConvertFrom-Json),
  @{ at = "2026-10-12T14:59:19.846Z" },
  @{ at = $expected }
)) {
  $actual = Get-EventUtcTime $event
  Assert-True ($actual.Ticks -eq $expected.Ticks) "Event timestamp lost fractional milliseconds"
  Assert-True ($actual.AddSeconds(3).Ticks - $expected.Ticks -eq 30000000) "Gate deadline must retain a full three seconds"
}
$presentation = @{ source = "frame-subscription"; width = 1024; height = 720; controls = @(
  @{ selector = ".new-thread-action"; textPresent = $true; contrast = 100; contrastingPixels = 20 },
  @{ selector = ".settings-nav-row"; textPresent = $true; contrast = 100; contrastingPixels = 20 }
) }
Assert-RendererPresentation @{ presentation = $presentation }
Assert-Throws { Assert-RendererPresentation @{} } "accepted presentation"
$presentation.width = 0
Assert-Throws { Assert-RendererPresentation @{ presentation = $presentation } } "accepted presentation"
$presentation.width = 1024
$presentation.controls[0].contrast = 0
Assert-Throws { Assert-RendererPresentation @{ presentation = $presentation } } "visible text/pixel"
$presentation.controls[0].contrast = 100
$presentation.controls[0].contrastingPixels = 1
Assert-Throws { Assert-RendererPresentation @{ presentation = $presentation } } "visible text/pixel"
$presentation.controls[0].contrastingPixels = 20
$presentation.controls[0].textPresent = $false
Assert-Throws { Assert-RendererPresentation @{ presentation = $presentation } } "visible text/pixel"
$presentation.controls = @()
Assert-Throws { Assert-RendererPresentation @{ presentation = $presentation } } "missing product controls"
Assert-SoleVisibleWindow 123 ([IntPtr]::new(42))
[StartupWindows]::Handles = [long[]]@()
Assert-Throws { Assert-SoleVisibleWindow 123 ([IntPtr]::new(42)) } "sole, visible"
[StartupWindows]::Handles = [long[]]@(43)
Assert-Throws { Assert-SoleVisibleWindow 123 ([IntPtr]::new(42)) } "sole, visible"
[StartupWindows]::Handles = [long[]]@(42, 43)
Assert-Throws { Assert-SoleVisibleWindow 123 ([IntPtr]::new(42)) } "sole, visible"
[StartupWindows]::Handles = [long[]]@(42)
[StartupWindows]::Minimized = $true
Assert-Throws { Assert-SoleVisibleWindow 123 ([IntPtr]::new(42)) } "non-minimized"
Write-Phase "assertions-complete"

$utf8 = [Text.UTF8Encoding]::new($false)
$directory = Join-Path ([IO.Path]::GetTempPath()) ("zenx-cleanup-unit-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $directory | Out-Null
$global:kills = 0
$global:killExit = 0
function taskkill { $global:kills++; $global:LASTEXITCODE = $global:killExit }
function Fake-Process($Id) {
  $value = [pscustomobject]@{ Id = $Id; HasExited = $false; Waits = 0 }
  $value | Add-Member ScriptMethod WaitForExit { param($timeout) $this.Waits++; return $this.Waits -gt 1 }
  return $value
}
try {
  Write-Phase "mock-cleanup-start"
  $process = Fake-Process 123
  Stop-Fixture $process $directory
  Assert-True ($global:kills -eq 1 -and $process.Waits -eq 2) "Force cleanup must check post-taskkill exit"
  $global:killExit = 5
  Assert-Throws { Stop-Fixture (Fake-Process 124) $directory } "taskkill exited with 5"
  $global:killExit = 0
  $stuck = Fake-Process 125
  $stuck | Add-Member ScriptMethod WaitForExit { param($timeout) return $false } -Force
  Assert-Throws { Stop-Fixture $stuck $directory } "still running"
  $first = Fake-Process 126
  $first | Add-Member ScriptMethod WaitForExit { param($timeout) throw "synthetic first cleanup failure" } -Force
  $second = Fake-Process 127
  $errors = @(Stop-OwnedFixtures @($first, $second) $directory)
  Assert-True ($errors.Count -eq 1 -and $errors[0] -match "synthetic first" -and $second.Waits -eq 2) "A failed first cleanup must not skip the second"
  $file = Join-Path $directory "not-a-directory"
  [IO.File]::WriteAllText($file, "fixture")
  $quitFailure = Fake-Process 128
  Assert-Throws { Stop-Fixture $quitFailure $file } "Quit signal"
  Assert-True ($quitFailure.Waits -eq 2) "Failed quit signalling must still try owned-process cleanup"
  Write-Phase "mock-cleanup-complete"
  Write-Host "Startup harness helper checks passed (mock Win32/process boundary; no native timing claim)."
} finally {
  Write-Phase "temporary-directory-cleanup-start"
  Remove-Item -LiteralPath $directory -Recurse -Force
  Write-Phase "temporary-directory-cleanup-complete"
}
