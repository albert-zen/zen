param(
  [switch]$TreeFixture,
  [switch]$MarkerFixture,
  [string]$MarkerPath,
  [string]$ChildPidPath
)

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

if ($MarkerFixture) {
  if (-not $MarkerPath -or -not $ChildPidPath) {
    throw 'Marker fixture requires marker and child PID paths.'
  }
  $fixtureChild = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 60"' `
    -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $ChildPidPath -Value ([string]$fixtureChild.Id) -Encoding ascii
  while (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
    Start-Sleep -Milliseconds 25
  }
  $fixtureChild.Dispose()
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
$harnessRoot = Join-Path $env:TEMP "imzen-live-ownership-$PID"
$runDirectory = Join-Path $harnessRoot 'run'
$descriptorPath = Join-Path $runDirectory 'imzen-live.json'
$gracefulShutdownTimeoutSeconds = 2
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

$scriptText = Get-Content -LiteralPath $scriptPath -Raw
if ($scriptText -notmatch "role = 'ZenX'" -and $scriptText -notmatch "'ZenX'") {
  throw 'imzen-live.ps1 does not register a managed ZenX process.'
}
if ($scriptText -notmatch 'ZEN_DESKTOP_SHUTDOWN_FILE') {
  throw 'imzen-live.ps1 does not provide ZenX a graceful shutdown marker.'
}
$descriptorBlock = [regex]::Match(
  $scriptText,
  '(?s)\$descriptor = \[PSCustomObject\]@\{(?<body>.*?)\r?\n  \}\r?\n  Register-ManagedStartup'
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

  $marker = Join-Path $runDirectory 'zenx-marker-fixture.shutdown'
  $markerChildPidPath = Join-Path $harnessRoot 'marker-child.pid'
  $markerRoot = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList "-NoProfile -File `"$PSCommandPath`" -MarkerFixture -MarkerPath `"$marker`" -ChildPidPath `"$markerChildPidPath`"" `
    -WindowStyle Hidden -PassThru
  $unrelated = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 60"' `
    -WindowStyle Hidden -PassThru
  $markerChildPid = $null
  try {
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      if (Test-Path -LiteralPath $markerChildPidPath -PathType Leaf) {
        $markerChildPid = [int](Get-Content -LiteralPath $markerChildPidPath -Raw)
        break
      }
      Start-Sleep -Milliseconds 25
    }
    if ($null -eq $markerChildPid) { throw 'Marker fixture did not publish its child PID.' }
    $markerIdentity = Get-ProcessIdentity $markerRoot 'ZenX'
    $markerDescriptor = [PSCustomObject]@{
      version = 3
      appServerUrl = 'http://127.0.0.1:32177'
      projectId = 'marker-fixture'
      imzenLog = Join-Path $env:TEMP 'missing-marker-fixture.log'
      shutdownMarkers = [PSCustomObject]@{
        appServer = $null
        imzen = $null
        zenx = $marker
      }
      appServer = $null
      imzen = $null
      zenx = $markerIdentity
    }

    Stop-LiveProcesses $markerDescriptor

    $markerChild = Get-CimInstance Win32_Process -Filter "ProcessId=$markerChildPid" -ErrorAction SilentlyContinue
    if ($null -ne $markerChild) {
      throw "Graceful root cleanup left owned child PID $markerChildPid running."
    }
    $unrelated.Refresh()
    if ($unrelated.HasExited) {
      throw 'Graceful owned-tree cleanup terminated an unrelated process.'
    }
  } finally {
    $markerRoot.Refresh()
    if (-not $markerRoot.HasExited) {
      $markerRoot.Kill()
      [void]$markerRoot.WaitForExit(5000)
    }
    $markerRoot.Dispose()
    if ($null -ne $markerChildPid) {
      $markerChild = Get-Process -Id $markerChildPid -ErrorAction SilentlyContinue
      if ($null -ne $markerChild) {
        $markerChild.Kill()
        [void]$markerChild.WaitForExit(5000)
        $markerChild.Dispose()
      }
    }
    $unrelated.Refresh()
    if (-not $unrelated.HasExited) {
      $unrelated.Kill()
      [void]$unrelated.WaitForExit(5000)
    }
    $unrelated.Dispose()
  }

  $savedCapability = [Environment]::GetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY', 'Process')
  $savedCapabilityDirectory = [Environment]::GetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_DIR', 'Process')
  $savedCapabilityHandoff = [Environment]::GetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_HANDOFF', 'Process')
  try {
    $managedEnvironmentNames = @(Get-ManagedEnvironmentNames)
    foreach ($name in @(
      'ZEN_APP_SERVER_CAPABILITY',
      'ZEN_APP_SERVER_CAPABILITY_DIR',
      'ZEN_APP_SERVER_CAPABILITY_HANDOFF'
    )) {
      if ($managedEnvironmentNames -notcontains $name) {
        throw "Managed environment restoration does not track $name."
      }
    }
    $env:ZEN_APP_SERVER_CAPABILITY_DIR = $harnessRoot
    $env:ZEN_APP_SERVER_CAPABILITY_HANDOFF = Join-Path $harnessRoot 'ambient-handoff.json'
    Set-GeneratedAppServerCredentialEnvironment ('x' * 32)
    if ($env:ZEN_APP_SERVER_CAPABILITY -ne ('x' * 32)) {
      throw 'Managed capability environment did not install the generated capability.'
    }
    if ($null -ne [Environment]::GetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_DIR', 'Process')) {
      throw 'Managed capability environment retained ambient capability-directory mode.'
    }
    if ($null -ne [Environment]::GetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_HANDOFF', 'Process')) {
      throw 'Managed capability environment retained ambient capability handoff.'
    }
  } finally {
    [Environment]::SetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY', $savedCapability, 'Process')
    [Environment]::SetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_DIR', $savedCapabilityDirectory, 'Process')
    [Environment]::SetEnvironmentVariable('ZEN_APP_SERVER_CAPABILITY_HANDOFF', $savedCapabilityHandoff, 'Process')
  }

  $raceProcesses = @()
  $raceChildPidPath = Join-Path $harnessRoot 'race-child.pid'
  $raceMarkerPath = Join-Path $harnessRoot 'never-requested-race-marker.shutdown'
  $raceUnrelated = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 60"' `
    -WindowStyle Hidden -PassThru
  try {
    foreach ($role in @('Zen App Server', 'IMZen', 'ZenX')) {
      $raceProcess = if ($role -eq 'ZenX') {
        Start-Process -FilePath 'powershell.exe' `
          -ArgumentList "-NoProfile -File `"$PSCommandPath`" -MarkerFixture -MarkerPath `"$raceMarkerPath`" -ChildPidPath `"$raceChildPidPath`"" `
          -WindowStyle Hidden -PassThru
      } else {
        Start-Process -FilePath 'powershell.exe' `
          -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 60"' `
          -WindowStyle Hidden -PassThru
      }
      $raceProcesses += [PSCustomObject]@{ process = $raceProcess; role = $role }
    }
    $raceChildPid = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      if (Test-Path -LiteralPath $raceChildPidPath -PathType Leaf) {
        $raceChildPid = [int](Get-Content -LiteralPath $raceChildPidPath -Raw)
        break
      }
      Start-Sleep -Milliseconds 25
    }
    if ($null -eq $raceChildPid) { throw 'Startup-race fixture did not publish its child PID.' }
    $raceIdentities = @(
      $raceProcesses | ForEach-Object { Get-ProcessIdentity $_.process $_.role }
    )
    $raceDescriptor = [PSCustomObject]@{
      version = 3
      appServerUrl = 'http://127.0.0.1:32177'
      projectId = 'startup-race'
      imzenLog = Join-Path $env:TEMP 'missing-startup-race.log'
      appServer = $raceIdentities | Where-Object { $_.role -eq 'Zen App Server' }
      imzen = $raceIdentities | Where-Object { $_.role -eq 'IMZen' }
      zenx = $raceIdentities | Where-Object { $_.role -eq 'ZenX' }
    }
    $zenxRaceProcess = ($raceProcesses | Where-Object { $_.role -eq 'ZenX' }).process
    $startupFailed = $false
    try {
      Register-ManagedStartup $raceDescriptor {
        $zenxRaceProcess.Kill()
        [void]$zenxRaceProcess.WaitForExit(5000)
      }
    } catch {
      $startupFailed = $true
    }
    if (-not $startupFailed) {
      throw 'Managed startup returned success after a role died during final registration.'
    }
    $racePids = @($raceIdentities | ForEach-Object { [int]$_.pid }) + @($raceChildPid)
    $raceResidual = @(
      Get-CimInstance Win32_Process |
        Where-Object { $racePids -contains [int]$_.ProcessId }
    )
    if ($raceResidual.Count -gt 0) {
      throw "Managed startup failure left owned PIDs: $($raceResidual.ProcessId -join ', ')."
    }
    if (Test-Path -LiteralPath $descriptorPath) {
      throw 'Managed startup failure left a stale live descriptor.'
    }
    $raceUnrelated.Refresh()
    if ($raceUnrelated.HasExited) {
      throw 'Managed startup-failure cleanup terminated an unrelated process.'
    }
  } finally {
    foreach ($entry in $raceProcesses) {
      $entry.process.Refresh()
      if (-not $entry.process.HasExited) {
        $entry.process.Kill()
        [void]$entry.process.WaitForExit(5000)
      }
      $entry.process.Dispose()
    }
    if ($null -ne $raceChildPid) {
      $raceChild = Get-Process -Id $raceChildPid -ErrorAction SilentlyContinue
      if ($null -ne $raceChild) {
        $raceChild.Kill()
        [void]$raceChild.WaitForExit(5000)
        $raceChild.Dispose()
      }
    }
    $raceUnrelated.Refresh()
    if (-not $raceUnrelated.HasExited) {
      $raceUnrelated.Kill()
      [void]$raceUnrelated.WaitForExit(5000)
    }
    $raceUnrelated.Dispose()
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
  Remove-Item -LiteralPath $harnessRoot -Recurse -Force -ErrorAction SilentlyContinue
}
