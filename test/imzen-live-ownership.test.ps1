param([switch]$TreeFixture)

$ErrorActionPreference = 'Stop'

if ($TreeFixture) {
  $fixtureChild = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 30"' `
    -WindowStyle Hidden -PassThru
  try {
    Start-Sleep -Seconds 30
  } finally {
    $fixtureChild.Refresh()
    if (-not $fixtureChild.HasExited) { $fixtureChild.Kill() }
    $fixtureChild.Dispose()
  }
  return
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptPath = Join-Path $repoRoot 'scripts\imzen-live.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  $scriptPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "imzen-live.ps1 has parser errors: $($parseErrors.Message -join '; ')"
}

$definitions = $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst]
}, $true)
foreach ($definition in $definitions) {
  Invoke-Expression $definition.Extent.Text
}

$child = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 30"' `
  -WindowStyle Hidden -PassThru
try {
  $actualCim = $null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    $actualCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)" -ErrorAction SilentlyContinue
    if ($null -ne $actualCim) { break }
    Start-Sleep -Milliseconds 25
  }
  if ($null -eq $actualCim) { throw "Unable to capture test child PID $($child.Id)." }

  $actual = ConvertTo-ProcessIdentity $actualCim 'IMZen'
  $stale = [PSCustomObject]@{
    role = 'IMZen'
    pid = $actual.pid
    parentPid = $actual.parentPid
    creationTime = $actual.creationTime
    executable = $actual.executable
    commandLine = "$($actual.commandLine) stale-descriptor"
  }
  $descriptor = [PSCustomObject]@{
    version = 2
    appServerUrl = 'http://127.0.0.1:1'
    projectId = 'test-project'
    imzenLog = Join-Path $env:TEMP 'missing-imzen-live-test.log'
    imzen = $stale
    appServer = $null
  }

  if (Show-Status $descriptor) {
    throw 'Show-Status treated a reused PID as the stale owned process.'
  }
  $child.Refresh()
  if ($child.HasExited) { throw 'Show-Status terminated the unrelated replacement process.' }

  $mismatchResult = Stop-IdentityBoundProcess ([PSCustomObject]@{
    key = 'stale'
    parentKey = $null
    depth = 0
    identity = $stale
  })
  if ($mismatchResult -ne 'identity-mismatch') {
    throw "Expected identity-mismatch, received $mismatchResult."
  }
  $child.Refresh()
  if ($child.HasExited) { throw 'Identity mismatch terminated the unrelated replacement process.' }

  $terminationResult = Stop-IdentityBoundProcess ([PSCustomObject]@{
    key = 'exact'
    parentKey = $null
    depth = 0
    identity = $actual
  })
  if ($terminationResult -ne 'terminated') {
    throw "Expected exact identity termination, received $terminationResult."
  }

  $treeRoot = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList "-NoProfile -File `"$PSCommandPath`" -TreeFixture" `
    -WindowStyle Hidden -PassThru
  try {
    $treeRootCim = $null
    $treeChildren = @()
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      $treeRootCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($treeRoot.Id)" -ErrorAction SilentlyContinue
      $treeChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($treeRoot.Id)" -ErrorAction SilentlyContinue)
      if ($null -ne $treeRootCim -and $treeChildren.Count -gt 0) { break }
      Start-Sleep -Milliseconds 25
    }
    if ($null -eq $treeRootCim -or $treeChildren.Count -eq 0) {
      throw 'Unable to capture the deterministic owned process tree.'
    }
    $treeIdentity = ConvertTo-ProcessIdentity $treeRootCim 'Harness tree'
    $treePids = @([int]$treeIdentity.pid) + @($treeChildren | ForEach-Object { [int]$_.ProcessId })

    Stop-VerifiedOwnedTree $treeIdentity

    $residual = @(Get-CimInstance Win32_Process | Where-Object { $treePids -contains [int]$_.ProcessId })
    if ($residual.Count -gt 0) {
      throw "Identity-bound tree fallback left residual test PIDs: $($residual.ProcessId -join ', ')."
    }
  } finally {
    $treeRoot.Refresh()
    if (-not $treeRoot.HasExited) {
      $treeRoot.Kill()
      [void]$treeRoot.WaitForExit(5000)
    }
    $treeRoot.Dispose()
  }
  Write-Output 'IMZen lifecycle ownership harness passed.'
} finally {
  $child.Refresh()
  if (-not $child.HasExited) {
    $child.Kill()
    [void]$child.WaitForExit(5000)
  }
  $child.Dispose()
}
