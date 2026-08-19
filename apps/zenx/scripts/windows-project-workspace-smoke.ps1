$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This smoke test must run on Windows."
}

$identifier = [guid]::NewGuid().ToString("N")
$documents = [Environment]::GetFolderPath("MyDocuments")
if ([string]::IsNullOrWhiteSpace($documents)) {
  throw "Windows did not expose a Documents directory for the picker smoke."
}
$fixtureName = "000-zenx-project-smoke-" + $identifier
$fixtureRoot = Join-Path $documents $fixtureName
$projectAName = "project-a-" + $identifier
$projectBName = "project-b-" + $identifier
$projectA = Join-Path $fixtureRoot $projectAName
$projectB = Join-Path $fixtureRoot $projectBName
$smokeRoot = Join-Path $env:TEMP ("zenx-project-workspace-smoke-" + $identifier)
$userData = Join-Path $smokeRoot "user-data"
$zenData = Join-Path $smokeRoot "zen-data"
$profilePath = Join-Path $userData "host-profile.json"
$acceptancePath = Join-Path $smokeRoot "acceptance.json"
$resultPath = Join-Path $smokeRoot "result.json"
$stdoutPath = Join-Path $smokeRoot "zenx.stdout.log"
$stderrPath = Join-Path $smokeRoot "zenx.stderr.log"
$process = $null
$previousZenData = $env:ZENX_DATA_DIR
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Utf8Json {
  param([string] $Path, [object] $Value, [int] $Depth = 2)
  $json = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Start-ZenXAcceptance {
  param([string] $Executable, [string] $UserData, [string] $Mode)
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  Write-Utf8Json -Path $acceptancePath -Value @{
    fixture = $fixtureName
    mode = $Mode
    projectA = $projectAName
    projectB = $projectBName
    resultPath = $resultPath
  }
  $previousAcceptance = $env:ZENX_PROJECT_ACCEPTANCE_CONFIG
  try {
    $env:ZENX_PROJECT_ACCEPTANCE_CONFIG = $acceptancePath
    return Start-Process -FilePath $Executable -ArgumentList @(
      ('--user-data-dir="' + $UserData + '"')
    ) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    $env:ZENX_PROJECT_ACCEPTANCE_CONFIG = $previousAcceptance
  }
}

function Write-AcceptanceDiagnostics {
  param($Process, [string] $Mode)
  $exitCode = "running"
  if ($null -ne $Process -and $Process.HasExited) { $exitCode = [string]$Process.ExitCode }
  Write-Host "ZenX packaged acceptance diagnostics: mode=$Mode pid=$($Process.Id) exitCode=$exitCode"
  foreach ($path in @($acceptancePath, $resultPath, $profilePath, $stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Write-Host "--- $path"
      Get-Content -Raw -LiteralPath $path | Write-Host
    } else {
      Write-Host "--- missing: $path"
    }
  }
  Write-Host "--- isolated directory listing: $smokeRoot"
  Get-ChildItem -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String | Write-Host
}

function Wait-ZenXAcceptance {
  param($Process, [string] $Mode)
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      Write-AcceptanceDiagnostics -Process $Process -Mode $Mode
      throw "Packaged ZenX exited with code $($Process.ExitCode) before reporting the $Mode acceptance result."
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    Write-AcceptanceDiagnostics -Process $Process -Mode $Mode
    throw "Packaged ZenX did not report the $Mode acceptance result before timeout."
  }
  $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
  if ($result.ok -ne $true -or $result.applicationMenuAbsent -ne $true -or $result.mode -ne $Mode) {
    Write-AcceptanceDiagnostics -Process $Process -Mode $Mode
    throw "Packaged ZenX $Mode acceptance failed: $($result.error)"
  }
  Wait-Process -Id $Process.Id -Timeout 30 -ErrorAction SilentlyContinue
}

function Stop-ZenX {
  param($Process)
  if ($null -eq $Process) { return }
  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
}

try {
  New-Item -ItemType Directory -Path $fixtureRoot, $projectA, $projectB, $userData, $zenData -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $projectA "keep-me.txt") -Value "project-a-marker" -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $projectB "keep-me.txt") -Value "project-b-marker" -Encoding UTF8
  Write-Utf8Json -Path $profilePath -Depth 5 -Value @{
    version = 1
    onboardingComplete = $true
    provider = @{ type = "fake"; displayName = "Local demo" }
    defaultModel = "fake"
    titleModel = "gpt-5.6-luna"
    models = @("fake")
    workspace = $null
    workspaces = @()
    lastUsedWorkspace = $null
    approvalPolicy = "never"
  }

  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "ZenX build failed." }
  $packageOutput = & node ./scripts/package-zenx-portable.mjs --app
  if ($LASTEXITCODE -ne 0) { throw "ZenX portable packaging failed." }
  $packageLines = @($packageOutput)
  $jsonStart = 0
  while ($jsonStart -lt $packageLines.Count -and $packageLines[$jsonStart].Trim() -ne "{") {
    $jsonStart++
  }
  if ($jsonStart -ge $packageLines.Count) {
    throw "ZenX portable packaging did not report its artifact as JSON."
  }
  $package = ($packageLines[$jsonStart..($packageLines.Count - 1)] -join [Environment]::NewLine) | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $package.executable -PathType Leaf)) {
    throw "Packaged ZenX executable is missing: $($package.executable)"
  }

  $env:ZENX_DATA_DIR = $zenData
  $process = Start-ZenXAcceptance -Executable $package.executable -UserData $userData -Mode "mutate"
  Wait-ZenXAcceptance -Process $process -Mode "mutate"

  $profile = Get-Content -Raw -LiteralPath $profilePath | ConvertFrom-Json
  if ($profile.workspace -ne (Resolve-Path -LiteralPath $projectB).Path) {
    throw "Default Project was not persisted as project B."
  }
  if (@($profile.workspaces).Count -ne 1 -or $profile.workspaces[0] -ne (Resolve-Path -LiteralPath $projectB).Path) {
    throw "Removed Project configuration was not persisted correctly."
  }
  if ((Get-Content -Raw -LiteralPath (Join-Path $projectA "keep-me.txt")).Trim() -ne "project-a-marker") {
    throw "Removing Project A changed its marker file."
  }
  if ((Get-Content -Raw -LiteralPath (Join-Path $projectB "keep-me.txt")).Trim() -ne "project-b-marker") {
    throw "Project B marker changed unexpectedly."
  }

  Stop-ZenX -Process $process
  $process = $null
  $process = Start-ZenXAcceptance -Executable $package.executable -UserData $userData -Mode "restart"
  Wait-ZenXAcceptance -Process $process -Mode "restart"
  Write-Host "ZenX packaged Project acceptance passed: add -> default -> remove -> restart, marker preservation, and no Windows application menu."
} finally {
  if ($null -ne $process) { Stop-ZenX -Process $process }
  $env:ZENX_DATA_DIR = $previousZenData
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
