$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This smoke test must run on Windows."
}
if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "WinApp CLI is missing. Install it with: winget install Microsoft.winappcli --source winget"
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
$process = $null
$previousZenData = $env:ZENX_DATA_DIR

function Start-ZenX {
  param([string] $Executable, [string] $UserData)
  $started = Start-Process -FilePath $Executable -ArgumentList @("--user-data-dir=$UserData") -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $started.Refresh()
    $candidate = Get-Process -Name "ZenX" -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -eq "ZenX" } |
      Select-Object -First 1
  } while ($null -eq $candidate -and -not $started.HasExited -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $candidate) {
    throw "Packaged ZenX did not expose its main window before timeout."
  }
  return $candidate
}

function Stop-ZenX {
  param($Process)
  if ($null -eq $Process) { return }
  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
}

function Invoke-ProjectDriver {
  param($Process, [string] $Fixture, [string] $ProjectA, [string] $ProjectB, [string] $Mode)
  & npx --no-install tsx ./src/main/project-workspace-smoke.ts `
    --pid $Process.Id `
    --title "ZenX" `
    --fixture $Fixture `
    --project-a $ProjectA `
    --project-b $ProjectB `
    --mode $Mode
  if ($LASTEXITCODE -ne 0) {
    throw "ZenX packaged Project driver failed in $Mode phase with exit code $LASTEXITCODE."
  }
}

try {
  New-Item -ItemType Directory -Path $fixtureRoot, $projectA, $projectB, $userData, $zenData -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $projectA "keep-me.txt") -Value "project-a-marker" -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $projectB "keep-me.txt") -Value "project-b-marker" -Encoding UTF8
  @{
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
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $profilePath -Encoding UTF8

  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "ZenX build failed." }
  $packageOutput = & node ./scripts/package-zenx-portable.mjs --app
  if ($LASTEXITCODE -ne 0) { throw "ZenX portable packaging failed." }
  $package = $packageOutput | Out-String | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $package.executable -PathType Leaf)) {
    throw "Packaged ZenX executable is missing: $($package.executable)"
  }

  $env:ZENX_DATA_DIR = $zenData
  $process = Start-ZenX -Executable $package.executable -UserData $userData
  Invoke-ProjectDriver -Process $process -Fixture $fixtureName -ProjectA $projectAName -ProjectB $projectBName -Mode "mutate"

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
  $process = Start-ZenX -Executable $package.executable -UserData $userData
  Invoke-ProjectDriver -Process $process -Fixture $fixtureName -ProjectA $projectAName -ProjectB $projectBName -Mode "restart"
  Write-Host "ZenX packaged Project acceptance passed: add -> default -> remove -> restart, marker preservation, and no Windows application menu."
} finally {
  if ($null -ne $process) { Stop-ZenX -Process $process }
  $env:ZENX_DATA_DIR = $previousZenData
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
