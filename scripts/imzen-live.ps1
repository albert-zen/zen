param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'status', 'stop')]
  [string]$Action = 'status',

  [string]$SecretFile,
  [string]$ProjectRoot,
  [ValidateRange(1, 65535)]
  [int]$Port = 32177,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = if ($env:ZEN_APP_DATA_ROOT) {
  [IO.Path]::GetFullPath($env:ZEN_APP_DATA_ROOT)
} else {
  Join-Path $env:LOCALAPPDATA 'Zen Agent'
}
$runDirectory = Join-Path $dataRoot 'run'
$logDirectory = Join-Path $dataRoot 'logs'
$descriptorPath = Join-Path $runDirectory 'imzen-live.json'
$gracefulShutdownTimeoutSeconds = 15

function Get-ProcessIdentity([Diagnostics.Process]$Process, [string]$Role) {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction Stop
  if ($null -eq $cim) { throw "Unable to read the identity of $Role PID $($Process.Id)." }
  ConvertTo-ProcessIdentity $cim $Role
}

function ConvertTo-ProcessIdentity($Cim, [string]$Role = $null) {
  [PSCustomObject]@{
    role = $Role
    pid = [int]$Cim.ProcessId
    parentPid = [int]$Cim.ParentProcessId
    creationTime = $Cim.CreationDate.ToUniversalTime().ToString('o')
    executable = $Cim.ExecutablePath
    commandLine = $Cim.CommandLine
  }
}

function Get-VerifiedProcess($Expected) {
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.pid)" -ErrorAction SilentlyContinue
  if ($null -eq $actual) { return $null }
  $mismatches = @(Get-ProcessIdentityMismatches $Expected (ConvertTo-ProcessIdentity $actual))
  if ($mismatches.Count -gt 0) {
    throw "Refusing to manage PID $($Expected.pid): owned identity mismatch ($($mismatches -join ', '))."
  }
  return $actual
}

function Get-ProcessIdentityMismatches($Expected, $Actual) {
  $mismatches = @()
  if ([int]$Actual.pid -ne [int]$Expected.pid) { $mismatches += 'pid' }
  if ([string]$Actual.creationTime -cne [string]$Expected.creationTime) {
    $mismatches += 'creationTime'
  }
  if ($Expected.PSObject.Properties.Name -contains 'parentPid') {
    if ([int]$Actual.parentPid -ne [int]$Expected.parentPid) { $mismatches += 'parentPid' }
  }
  if ([string]$Actual.executable -ine [string]$Expected.executable) {
    $mismatches += 'executable'
  }
  if ([string]$Actual.commandLine -cne [string]$Expected.commandLine) {
    $mismatches += 'commandLine'
  }
  return $mismatches
}

function Test-SameProcessIdentity($Expected, $Actual) {
  return $null -ne $Actual -and @(Get-ProcessIdentityMismatches $Expected $Actual).Count -eq 0
}

function Read-Descriptor {
  if (-not (Test-Path -LiteralPath $descriptorPath)) { return $null }
  $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
  if ($descriptor.version -notin @(1, 2, 3)) {
    throw "Unsupported IMZen live descriptor version: $($descriptor.version)."
  }
  return $descriptor
}

function Write-Descriptor($Value) {
  New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
  $temporaryPath = "$descriptorPath.$PID.tmp"
  $Value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $descriptorPath -Force
}

function Get-DescriptorProcesses($Descriptor) {
  @($Descriptor.imzen, $Descriptor.zenx, $Descriptor.appServer) | Where-Object { $null -ne $_ }
}

function Test-CompleteManagedDescriptor($Descriptor) {
  return (
    $null -ne $Descriptor -and
    $Descriptor.version -eq 3 -and
    $null -ne $Descriptor.imzen -and
    $null -ne $Descriptor.zenx -and
    $null -ne $Descriptor.appServer
  )
}

function Get-DescriptorShutdownMarker($Descriptor, [string]$Role) {
  if ($Descriptor.version -notin @(2, 3) -or $null -eq $Descriptor.shutdownMarkers) { return $null }
  $marker = $Descriptor.shutdownMarkers.$Role
  if ($null -eq $marker -or -not ([string]$marker).Trim()) { return $null }
  $fullMarkerPath = [IO.Path]::GetFullPath([string]$marker)
  $fullRunDirectory = [IO.Path]::GetFullPath($runDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (-not $fullMarkerPath.StartsWith("$fullRunDirectory$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing shutdown marker outside the managed run directory for $Role."
  }
  return $fullMarkerPath
}

function Request-GracefulShutdown($Descriptor, $Expected) {
  $markerRole = if ($Expected.role -eq 'IMZen') {
    'imzen'
  } elseif ($Expected.role -eq 'ZenX') {
    'zenx'
  } elseif ($Expected.role -eq 'Zen App Server') {
    'appServer'
  } else {
    throw "Unknown managed process role: $($Expected.role)"
  }
  $marker = Get-DescriptorShutdownMarker $Descriptor $markerRole
  if ($null -eq $marker) { return $false }
  if ((Test-Path -LiteralPath $marker) -and (Get-Item -LiteralPath $marker).PSIsContainer) {
    throw "Shutdown marker for $($Expected.role) is not a file: $marker"
  }
  $markerHandle = [IO.File]::Open(
    $marker,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::Write,
    [IO.FileShare]::Read
  )
  try {
    $markerHandle.Flush()
  } finally {
    $markerHandle.Dispose()
  }
  Write-Host "Requested graceful shutdown for $($Expected.role) PID $($Expected.pid)."
  return $true
}

function Wait-ForVerifiedProcessExit($Expected, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (-not (Test-VerifiedProcessStillRunning $Expected)) { return $true }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  return -not (Test-VerifiedProcessStillRunning $Expected)
}

function Test-VerifiedProcessStillRunning($Expected) {
  try {
    return $null -ne (Get-VerifiedProcess $Expected)
  } catch {
    if ($_.Exception.Message -like "Refusing to manage PID $($Expected.pid): owned identity mismatch*") {
      Write-Warning "Recorded $($Expected.role) PID $($Expected.pid) was reused; treating the owned process as exited."
      return $false
    }
    throw
  }
}

function Stop-VerifiedOwnedTree($Expected) {
  $rootIdentity = [PSCustomObject]@{
    role = $Expected.role
    pid = [int]$Expected.pid
    creationTime = [string]$Expected.creationTime
    executable = [string]$Expected.executable
    commandLine = [string]$Expected.commandLine
  }
  if ($Expected.PSObject.Properties.Name -contains 'parentPid') {
    $rootIdentity | Add-Member -NotePropertyName parentPid -NotePropertyValue ([int]$Expected.parentPid)
  }
  $rootKey = Get-ProcessIdentityKey $rootIdentity
  $ledger = @{
    $rootKey = [PSCustomObject]@{
      key = $rootKey
      parentKey = $null
      depth = 0
      identity = $rootIdentity
    }
  }
  $terminated = @()

  $initialSnapshot = @(Get-ProcessSnapshot)
  [void](Add-OwnedDescendantsToLedger $ledger $initialSnapshot)
  $rootResult = Stop-IdentityBoundProcess $ledger[$rootKey]
  if ($rootResult -eq 'terminated') { $terminated += [int]$Expected.pid }

  for ($pass = 0; $pass -lt 32; $pass += 1) {
    $discoverySnapshot = @(Get-ProcessSnapshot)
    [void](Add-OwnedDescendantsToLedger $ledger $discoverySnapshot)
    $discoveredLive = @(Get-LiveOwnedRecords $ledger $discoverySnapshot | Where-Object { $_.depth -gt 0 })

    $currentSnapshot = @(Get-ProcessSnapshot)
    [void](Add-OwnedDescendantsToLedger $ledger $currentSnapshot)
    $currentLive = @(Get-LiveOwnedRecords $ledger $currentSnapshot | Where-Object { $_.depth -gt 0 })

    if ($discoveredLive.Count -eq 0 -and $currentLive.Count -eq 0) {
      if ($terminated.Count -gt 0) {
        Write-Warning "Forced termination fallback used for $($Expected.role) owned tree rooted at PID $($Expected.pid); identity-bound PIDs: $($terminated -join ', ')."
      } else {
        Write-Warning "$($Expected.role) PID $($Expected.pid) exited before identity-bound force termination; no PID was killed."
      }
      return
    }
    if ($currentLive.Count -eq 0) { continue }

    $candidate = $currentLive | Sort-Object depth -Descending | Select-Object -First 1
    $result = Stop-IdentityBoundProcess $candidate
    if ($result -eq 'terminated') { $terminated += [int]$candidate.identity.pid }
  }

  $residualSnapshot = @(Get-ProcessSnapshot)
  [void](Add-OwnedDescendantsToLedger $ledger $residualSnapshot)
  $residual = @(Get-LiveOwnedRecords $ledger $residualSnapshot)
  $residualDescription = if ($residual.Count -eq 0) {
    'late or unverifiable residual may remain'
  } else {
    "verified residual PIDs: $($residual.identity.pid -join ', ')"
  }
  throw "Owned process cleanup did not reach quiescence after 32 passes for $($Expected.role): $residualDescription."
}

function Get-ProcessSnapshot {
  @(Get-CimInstance Win32_Process | ForEach-Object { ConvertTo-ProcessIdentity $_ })
}

function Get-ProcessIdentityKey($Identity) {
  return "$($Identity.pid):$($Identity.creationTime):$($Identity.executable):$($Identity.commandLine)"
}

function Get-CreationTime($Identity) {
  try {
    return [DateTimeOffset]::Parse([string]$Identity.creationTime).ToUniversalTime()
  } catch {
    throw "Unverifiable process identity for PID $($Identity.pid): invalid creation time."
  }
}

function Add-OwnedDescendantsToLedger([hashtable]$Ledger, [object[]]$Processes) {
  $added = 0
  do {
    $madeProgress = $false
    foreach ($parent in @($Ledger.Values)) {
      foreach ($child in @($Processes | Where-Object { [int]$_.parentPid -eq [int]$parent.identity.pid })) {
        $childKey = Get-ProcessIdentityKey $child
        if ($Ledger.ContainsKey($childKey)) { continue }
        $childCreation = Get-CreationTime $child
        $parentCreation = Get-CreationTime $parent.identity
        if ($childCreation -lt $parentCreation) { continue }

        $holder = $Processes | Where-Object { [int]$_.pid -eq [int]$parent.identity.pid } |
          Select-Object -First 1
        if ($null -ne $holder -and -not (Test-SameProcessIdentity $parent.identity $holder)) {
          if ($childCreation -ge (Get-CreationTime $holder)) { continue }
        }
        if (-not $child.executable -or -not $child.commandLine) {
          throw "Unverifiable owned descendant PID $($child.pid) remains under recorded PID $($parent.identity.pid)."
        }

        $Ledger[$childKey] = [PSCustomObject]@{
          key = $childKey
          parentKey = $parent.key
          depth = [int]$parent.depth + 1
          identity = $child
        }
        $added += 1
        $madeProgress = $true
      }
    }
  } while ($madeProgress)
  return $added
}

function Get-LiveOwnedRecords([hashtable]$Ledger, [object[]]$Processes) {
  foreach ($record in @($Ledger.Values)) {
    $actual = $Processes | Where-Object { [int]$_.pid -eq [int]$record.identity.pid } |
      Select-Object -First 1
    if (Test-SameProcessIdentity $record.identity $actual) { $record }
  }
}

function Stop-IdentityBoundProcess($Record) {
  $expected = $Record.identity
  $actualCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)" -ErrorAction SilentlyContinue
  if ($null -eq $actualCim) { return 'exited' }
  $actual = ConvertTo-ProcessIdentity $actualCim
  $mismatches = @(Get-ProcessIdentityMismatches $expected $actual)
  if ($mismatches.Count -gt 0) {
    Write-Warning "Refusing force termination for reused PID $($expected.pid): identity mismatch ($($mismatches -join ', '))."
    return 'identity-mismatch'
  }

  try {
    $processHandle = [Diagnostics.Process]::GetProcessById([int]$expected.pid)
  } catch [ArgumentException] {
    return 'exited'
  }
  try {
    if ($processHandle.HasExited) { return 'exited' }
    $handleCreation = [DateTimeOffset]$processHandle.StartTime.ToUniversalTime()
    $expectedCreation = Get-CreationTime $expected
    if ($handleCreation.ToUnixTimeMilliseconds() -ne $expectedCreation.ToUnixTimeMilliseconds()) {
      Write-Warning "Refusing force termination for reused PID $($expected.pid): process handle creation time changed."
      return 'identity-mismatch'
    }
    if ($processHandle.MainModule.FileName -ine [string]$expected.executable) {
      Write-Warning "Refusing force termination for reused PID $($expected.pid): process handle executable changed."
      return 'identity-mismatch'
    }

    $immediateCim = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)" -ErrorAction SilentlyContinue
    if ($null -eq $immediateCim) {
      if ($processHandle.HasExited) { return 'exited' }
      throw "Unverifiable residual PID $($expected.pid): CIM identity disappeared while its process handle remained live."
    }
    $immediateMismatches = @(
      Get-ProcessIdentityMismatches $expected (ConvertTo-ProcessIdentity $immediateCim)
    )
    if ($immediateMismatches.Count -gt 0) {
      Write-Warning "Refusing force termination for reused PID $($expected.pid): immediate identity mismatch ($($immediateMismatches -join ', '))."
      return 'identity-mismatch'
    }

    $processHandle.Kill()
    if (-not $processHandle.WaitForExit(5000)) {
      throw "Identity-bound PID $($expected.pid) did not exit within 5 seconds after force termination."
    }
    return 'terminated'
  } finally {
    $processHandle.Dispose()
  }
}

function Remove-ManagedControlFiles($Descriptor) {
  foreach ($role in @('imzen', 'zenx', 'appServer')) {
    $marker = Get-DescriptorShutdownMarker $Descriptor $role
    if ($null -ne $marker) {
      Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $descriptorPath -Force -ErrorAction SilentlyContinue
}

function Stop-LiveProcesses($Descriptor) {
  $failures = @()
  foreach ($expected in @(Get-DescriptorProcesses $Descriptor)) {
    try {
      if (-not (Test-VerifiedProcessStillRunning $expected)) { continue }
      $requested = Request-GracefulShutdown $Descriptor $expected
      if ($requested -and (Wait-ForVerifiedProcessExit $expected $gracefulShutdownTimeoutSeconds)) {
        Write-Output "$($expected.role) PID $($expected.pid) exited gracefully."
        continue
      }
      if ($requested) {
        Write-Warning "$($expected.role) PID $($expected.pid) did not exit within $gracefulShutdownTimeoutSeconds seconds."
      } else {
        Write-Warning "No graceful shutdown control is available for legacy $($expected.role) PID $($expected.pid)."
      }
      Stop-VerifiedOwnedTree $expected
    } catch {
      $failures += $_.Exception.Message
    }
  }
  if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
  Remove-ManagedControlFiles $Descriptor
}

function Show-Status($Descriptor) {
  if ($null -eq $Descriptor) {
    Write-Host 'IMZen live services are not registered.'
    return $false
  }
  $running = @()
  foreach ($expected in @(Get-DescriptorProcesses $Descriptor)) {
    if (Test-VerifiedProcessStillRunning $expected) {
      $running += $expected
      Write-Host "$($expected.role) PID $($expected.pid) is running."
    } else {
      Write-Host "$($expected.role) PID $($expected.pid) is not running."
    }
  }
  Write-Host "App Server: $($Descriptor.appServerUrl)"
  Write-Host "Project: $($Descriptor.projectId)"
  if (Test-Path -LiteralPath $Descriptor.imzenLog) {
    $pairing = Select-String -LiteralPath $Descriptor.imzenLog -Pattern '^IMZen pairing command:' |
      Select-Object -Last 1
    if ($null -ne $pairing) { Write-Host $pairing.Line }
  }
  $expectedCount = @(Get-DescriptorProcesses $Descriptor).Count
  return $expectedCount -gt 0 -and $running.Count -eq $expectedCount
}

function Invoke-AppServer([string]$Url, [string]$Capability, [string]$Method, $Params) {
  $body = @{ method = $Method; params = $Params } | ConvertTo-Json -Depth 8
  $response = Invoke-RestMethod -Uri "$Url/request" -Method Post -TimeoutSec 5 -Headers @{
    Authorization = "Bearer $Capability"
  } -ContentType 'application/json' -Body $body
  if (-not $response.ok) { throw "App Server $Method failed: $($response.error.message)" }
  return $response
}

function ConvertTo-QuotedProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

if ($Action -eq 'status') {
  [void](Show-Status (Read-Descriptor))
  exit 0
}

if ($Action -eq 'stop') {
  $descriptor = Read-Descriptor
  if ($null -eq $descriptor) {
    Write-Output 'IMZen live services are not registered.'
    exit 0
  }
  Stop-LiveProcesses $descriptor
  exit 0
}

if (-not $SecretFile) { throw 'start requires -SecretFile.' }
$resolvedSecretFile = (Resolve-Path -LiteralPath $SecretFile).Path
$resolvedProjectRoot = if ($ProjectRoot) {
  (Resolve-Path -LiteralPath $ProjectRoot).Path
} else {
  $repoRoot
}

$existing = Read-Descriptor
if ($null -ne $existing) {
  $existingRunning = Show-Status $existing
  if ((Test-CompleteManagedDescriptor $existing) -and $existingRunning) {
    Write-Output 'Managed Zen clients are already connected; no duplicate processes were started.'
    exit 0
  }
  Stop-LiveProcesses $existing
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listener) { throw "Port $Port is already in use." }

if (-not $SkipBuild) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Managed client build failed with exit code $LASTEXITCODE." }
}

$nodeExecutable = [IO.Path]::GetFullPath((& node.exe -p 'process.execPath').Trim())
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nodeExecutable)) {
  throw 'Unable to resolve the real Node.js executable.'
}
$electronExecutable = [IO.Path]::GetFullPath((& node.exe -e "process.stdout.write(require('electron'))").Trim())
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $electronExecutable)) {
  throw 'Unable to resolve the real Electron executable.'
}

New-Item -ItemType Directory -Path $runDirectory, $logDirectory -Force | Out-Null
$appServerShutdownMarker = Join-Path $runDirectory "app-server-$([guid]::NewGuid().ToString('N')).shutdown"
$imzenShutdownMarker = Join-Path $runDirectory "imzen-$([guid]::NewGuid().ToString('N')).shutdown"
$zenxShutdownMarker = Join-Path $runDirectory "zenx-$([guid]::NewGuid().ToString('N')).shutdown"
if (
  (Test-Path -LiteralPath $appServerShutdownMarker) -or
  (Test-Path -LiteralPath $imzenShutdownMarker) -or
  (Test-Path -LiteralPath $zenxShutdownMarker)
) {
  throw 'Generated shutdown marker path already exists.'
}
$appServerLog = Join-Path $logDirectory 'imzen-app-server.out.log'
$appServerErrorLog = Join-Path $logDirectory 'imzen-app-server.err.log'
$imzenLog = Join-Path $logDirectory 'imzen.out.log'
$imzenErrorLog = Join-Path $logDirectory 'imzen.err.log'
$zenxLog = Join-Path $logDirectory 'zenx.out.log'
$zenxErrorLog = Join-Path $logDirectory 'zenx.err.log'
Remove-Item -LiteralPath $appServerLog, $appServerErrorLog, $imzenLog, $imzenErrorLog, $zenxLog, $zenxErrorLog -Force -ErrorAction SilentlyContinue

$randomBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($randomBytes)
} finally {
  $random.Dispose()
}
$capability = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$url = "http://127.0.0.1:$Port"
$managedEnvironmentNames = @(
  'ZEN_APP_SERVER_HOST',
  'ZEN_APP_SERVER_PORT',
  'ZEN_APP_SERVER_CAPABILITY',
  'ZEN_APP_SERVER_URL',
  'ZEN_APP_SERVER_SHUTDOWN_FILE',
  'ZEN_DESKTOP_SHUTDOWN_FILE',
  'IMZEN_PROJECT_ID',
  'IMZEN_PROJECT_ROOT',
  'IMZEN_QQ_SECRET_FILE',
  'IMZEN_SHUTDOWN_FILE',
  'IMZEN_QQ_APP_ID',
  'IMZEN_QQ_APP_SECRET',
  'IMZEN_QQ_TOKEN'
)
$savedEnvironment = @{}
foreach ($name in $managedEnvironmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$appServerProcess = $null
$appServerIdentity = $null
$imzenProcess = $null
$imzenIdentity = $null
$zenxProcess = $null
$zenxIdentity = $null
try {
  foreach ($name in @('IMZEN_QQ_SECRET_FILE', 'IMZEN_QQ_APP_ID', 'IMZEN_QQ_APP_SECRET', 'IMZEN_QQ_TOKEN', 'IMZEN_SHUTDOWN_FILE')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  $env:ZEN_APP_SERVER_HOST = '127.0.0.1'
  $env:ZEN_APP_SERVER_PORT = [string]$Port
  $env:ZEN_APP_SERVER_CAPABILITY = $capability
  $env:ZEN_APP_SERVER_SHUTDOWN_FILE = $appServerShutdownMarker
  $appServerProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList (ConvertTo-QuotedProcessArgument (Join-Path $repoRoot 'apps\cli\dist\app-server-cli.js')) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $appServerLog -RedirectStandardError $appServerErrorLog
  $appServerIdentity = Get-ProcessIdentity $appServerProcess 'Zen App Server'

  $projectsResponse = $null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if ($appServerProcess.HasExited) {
      throw "Zen App Server exited during startup. See $appServerErrorLog."
    }
    try {
      $projectsResponse = Invoke-AppServer $url $capability 'project/list' @{}
      break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if ($null -eq $projectsResponse) { throw 'Zen App Server did not become ready within 10 seconds.' }

  $normalizedRoot = [IO.Path]::GetFullPath($resolvedProjectRoot).TrimEnd([char[]]@('\', '/')).ToLowerInvariant()
  $project = @($projectsResponse.result.projects) | Where-Object {
    [IO.Path]::GetFullPath([string]$_.rootPath).TrimEnd([char[]]@('\', '/')).ToLowerInvariant() -eq $normalizedRoot -and
      $_.status -ne 'archived'
  } | Select-Object -First 1
  if ($null -eq $project) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedRoot))
      $digest = ($hashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
    } finally {
      $sha.Dispose()
    }
    $created = Invoke-AppServer $url $capability 'project/create' @{
      name = Split-Path -Leaf $resolvedProjectRoot
      rootPath = $resolvedProjectRoot
      idempotencyKey = "imzen-live:$digest"
    }
    $project = $created.result.project
  }

  [Environment]::SetEnvironmentVariable('ZEN_APP_SERVER_SHUTDOWN_FILE', $null, 'Process')
  $env:ZEN_APP_SERVER_URL = $url
  $env:IMZEN_PROJECT_ID = [string]$project.id
  $env:IMZEN_PROJECT_ROOT = $resolvedProjectRoot
  $env:IMZEN_QQ_SECRET_FILE = $resolvedSecretFile
  $env:IMZEN_SHUTDOWN_FILE = $imzenShutdownMarker
  $imzenProcess = Start-Process -FilePath $nodeExecutable `
    -ArgumentList (ConvertTo-QuotedProcessArgument (Join-Path $repoRoot 'apps\imzen\dist\main.js')) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $imzenLog -RedirectStandardError $imzenErrorLog
  $imzenIdentity = Get-ProcessIdentity $imzenProcess 'IMZen'

  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if ($imzenProcess.HasExited) { throw "IMZen exited during startup. See $imzenErrorLog." }
    if (
      (Test-Path -LiteralPath $imzenLog) -and
      (Select-String -LiteralPath $imzenLog -Quiet -Pattern '^IMZen connected to QQ and Zen App Server\.$')
    ) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'IMZen did not connect within 20 seconds.' }

  $env:ZEN_DESKTOP_SHUTDOWN_FILE = $zenxShutdownMarker
  $zenxProcess = Start-Process -FilePath $electronExecutable `
    -ArgumentList (ConvertTo-QuotedProcessArgument (Join-Path $repoRoot 'apps\zenx')) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $zenxLog -RedirectStandardError $zenxErrorLog
  $zenxIdentity = Get-ProcessIdentity $zenxProcess 'ZenX'

  $zenxReady = $false
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if ($zenxProcess.HasExited) { throw "ZenX exited during startup. See $zenxErrorLog." }
    if (
      (Test-Path -LiteralPath $zenxLog) -and
      (Select-String -LiteralPath $zenxLog -Quiet -Pattern '^ZenX connected to the shared Zen App Server\.$')
    ) {
      $zenxReady = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $zenxReady) { throw 'ZenX did not connect within 20 seconds.' }

  $descriptor = [PSCustomObject]@{
    version = 3
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    appServerUrl = $url
    projectId = [string]$project.id
    projectRoot = $resolvedProjectRoot
    shutdownMarkers = [PSCustomObject]@{
      appServer = $appServerShutdownMarker
      imzen = $imzenShutdownMarker
      zenx = $zenxShutdownMarker
    }
    appServer = $appServerIdentity
    imzen = $imzenIdentity
    zenx = $zenxIdentity
    appServerLog = $appServerLog
    appServerErrorLog = $appServerErrorLog
    imzenLog = $imzenLog
    imzenErrorLog = $imzenErrorLog
    zenxLog = $zenxLog
    zenxErrorLog = $zenxErrorLog
  }
  Write-Descriptor $descriptor
  [void](Show-Status $descriptor)
} catch {
  $incompleteDescriptor = [PSCustomObject]@{
    version = 3
    shutdownMarkers = [PSCustomObject]@{
      appServer = $appServerShutdownMarker
      imzen = $imzenShutdownMarker
      zenx = $zenxShutdownMarker
    }
    appServer = $appServerIdentity
    imzen = $imzenIdentity
    zenx = $zenxIdentity
  }
  try {
    Stop-LiveProcesses $incompleteDescriptor
  } catch {
    Write-Warning "Incomplete startup cleanup failed: $($_.Exception.Message)"
  }
  throw
} finally {
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
  $capability = $null
  [Array]::Clear($randomBytes, 0, $randomBytes.Length)
}
