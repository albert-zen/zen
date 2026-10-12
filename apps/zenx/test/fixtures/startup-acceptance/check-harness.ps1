param([string] $HarnessPath)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load only the real harness helpers. Never execute its package or process launcher.
foreach ($name in @("Assert-SoleVisibleWindow", "Stop-Fixture", "Stop-OwnedFixtures")) {
  $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($functions.Count -ne 1) { throw "Missing unique helper $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
Add-Type -TypeDefinition @'
using System;
public static class StartupWindows {
  public static long[] Handles = new long[] { 42 };
  public static bool Minimized = false;
  public static long[] Visible(uint pid) { return Handles; }
  public static bool IsIconic(IntPtr hwnd) { return Minimized; }
}
'@
function Assert-True($Value, $Message) { if (!$Value) { throw $Message } }
function Assert-Throws([scriptblock] $Action, $Pattern) {
  $caught = $null
  try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
  if ($null -eq $caught -or $caught -notmatch $Pattern) { throw "Expected $Pattern; received $caught" }
}
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
  Write-Host "Startup harness helper checks passed (mock Win32/process boundary; no native timing claim)."
} finally {
  Remove-Item -LiteralPath $directory -Recurse -Force
}
