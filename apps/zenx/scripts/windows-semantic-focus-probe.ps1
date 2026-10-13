$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Only the disposable native smoke fixture calls this probe; it is not a product fallback.
Add-Type -ReferencedAssemblies System,System.Core -Path (Join-Path $PSScriptRoot "windows-semantic-focus-probe.cs")
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$control = if ($request.action -eq "invoke") { $request.fixture.button } else { $request.fixture.editor }
$result = [ZenXSemanticFocusProbe]::Run(
  [long]$request.fixture.window, [long]$control.hwnd,
  [long]$request.fixture.guardWindow, [long]$request.fixture.guard.hwnd,
  [int]$request.fixture.pid, [long]$request.fixture.started,
  [string]$control.className, [string]$request.fixture.guard.className,
  [string]$request.action, [bool]$request.suppressAutoFocus,
  [string]$request.value, [string]$request.phasePath
)
$rejections = @()
if ($request.action -eq "set-value" -and $request.suppressAutoFocus) {
  foreach ($case in @("wrong-process", "same-pid-sibling", "stale-hwnd", "unsupported-pattern")) {
    $testPid = [int]$request.fixture.pid
    $testControl = [long]$control.hwnd
    $testClass = [string]$control.className
    if ($case -eq "wrong-process") { $testPid = $PID }
    if ($case -eq "same-pid-sibling") { $testControl = [long]$request.fixture.guard.hwnd; $testClass = [string]$request.fixture.guard.className }
    if ($case -eq "stale-hwnd") { $testControl = 0 }
    if ($case -eq "unsupported-pattern") { $testControl = [long]$request.fixture.unsupported.hwnd; $testClass = [string]$request.fixture.unsupported.className }
    $rejected = $false
    try {
      [ZenXSemanticFocusProbe]::Run(
        [long]$request.fixture.window, $testControl,
        [long]$request.fixture.guardWindow, [long]$request.fixture.guard.hwnd,
        $testPid, [long]$request.fixture.started, $testClass, [string]$request.fixture.guard.className,
        "set-value", $true, "must not be written", [string]$request.phasePath
      ) | Out-Null
    } catch {
      if ($case -ne "unsupported-pattern" -and $_.Exception.ToString() -notmatch "Fixture HWND identity mismatch") { throw }
      if ($case -eq "unsupported-pattern" -and $_.Exception.ToString() -notmatch "requested pattern|0x80040200") { throw }
      $rejected = $true
    }
    if (-not $rejected) { throw "Direct UIA boundary probe was not rejected: $case" }
    $rejections += $case
  }
}
@{ observation = $result; rejections = $rejections } | ConvertTo-Json -Compress -Depth 5
