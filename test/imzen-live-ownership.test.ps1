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

$scriptText = Get-Content -LiteralPath $scriptPath -Raw
if ($scriptText -notmatch "role = 'ZenX'" -and $scriptText -notmatch "'ZenX'") {
  throw 'imzen-live.ps1 does not register a managed ZenX process.'
}
if ($scriptText -notmatch 'ZEN_DESKTOP_SHUTDOWN_FILE') {
  throw 'imzen-live.ps1 does not provide ZenX a graceful shutdown marker.'
}
$descriptorBlock = [regex]::Match(
  $scriptText,
  '(?s)\$descriptor = \[PSCustomObject\]@\{(?<body>.*?)\r?\n  \}\r?\n  Write-Descriptor'
)
if (-not $descriptorBlock.Success) {
  throw 'Unable to inspect the managed descriptor block.'
}
if ($descriptorBlock.Groups['body'].Value -match '(?i)capability|appSecret') {
  throw 'Managed descriptor block includes a capability or QQ app secret.'
}
$managedSet = @(Get-DescriptorProcesses ([PSCustomObject]@{
  imzen = [PSCustomObject]@{ role = 'IMZen' }
  zenx = [PSCustomObject]@{ role = 'ZenX' }
  appServer = [PSCustomObject]@{ role = 'Zen App Server' }
}))
if (($managedSet.role -join ',') -ne 'IMZen,ZenX,Zen App Server') {
  throw "Managed shutdown order is incorrect: $($managedSet.role -join ',')."
}
$legacyDescriptor = [PSCustomObject]@{
  version = 2
  imzen = [PSCustomObject]@{ role = 'IMZen' }
  appServer = [PSCustomObject]@{ role = 'Zen App Server' }
}
if (Test-CompleteManagedDescriptor $legacyDescriptor) {
  throw 'Legacy two-process descriptor was treated as a complete managed set.'
}
$completeDescriptor = [PSCustomObject]@{
  version = 3
  imzen = [PSCustomObject]@{ role = 'IMZen' }
  zenx = [PSCustomObject]@{ role = 'ZenX' }
  appServer = [PSCustomObject]@{ role = 'Zen App Server' }
}
if (-not (Test-CompleteManagedDescriptor $completeDescriptor)) {
  throw 'Version 3 three-process descriptor was not treated as a complete managed set.'
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

  $managedProcesses = @()
  try {
    foreach ($role in @('Zen App Server', 'IMZen', 'ZenX')) {
      $managedProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 30"' `
        -WindowStyle Hidden -PassThru
      $managedProcesses += [PSCustomObject]@{
        process = $managedProcess
        role = $role
      }
    }
    $managedIdentities = @()
    foreach ($entry in $managedProcesses) {
      $managedIdentities += Get-ProcessIdentity $entry.process $entry.role
    }
    $managedDescriptor = [PSCustomObject]@{
      version = 3
      appServerUrl = 'http://127.0.0.1:32177'
      projectId = 'process-census'
      imzenLog = Join-Path $env:TEMP 'missing-imzen-live-census.log'
      appServer = $managedIdentities | Where-Object { $_.role -eq 'Zen App Server' }
      imzen = $managedIdentities | Where-Object { $_.role -eq 'IMZen' }
      zenx = $managedIdentities | Where-Object { $_.role -eq 'ZenX' }
    }
    if (-not (Show-Status $managedDescriptor)) {
      throw 'Three-role managed process census did not report a complete running set.'
    }
    $managedPids = @($managedIdentities | ForEach-Object { [int]$_.pid })
    foreach ($identity in @(Get-DescriptorProcesses $managedDescriptor)) {
      Stop-VerifiedOwnedTree $identity
    }
    $managedResidual = @(
      Get-CimInstance Win32_Process |
        Where-Object { $managedPids -contains [int]$_.ProcessId }
    )
    if ($managedResidual.Count -gt 0) {
      throw "Three-role managed process cleanup left residual PIDs: $($managedResidual.ProcessId -join ', ')."
    }
    Write-Output "Managed process census passed: started=3 running=3 residual=0."
  } finally {
    foreach ($entry in $managedProcesses) {
      $entry.process.Refresh()
      if (-not $entry.process.HasExited) {
        $entry.process.Kill()
        [void]$entry.process.WaitForExit(5000)
      }
      $entry.process.Dispose()
    }
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
