$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This smoke test must run on Windows."
}

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "WinApp CLI is missing. Install it with: winget install Microsoft.winappcli --source winget"
}

$fixture = $null
$fixtureScript = Join-Path $env:TEMP ("zenx-winapp-fixture-" + [guid]::NewGuid().ToString("N") + ".ps1")
$fixtureTitle = "ZenX WinApp Smoke " + [guid]::NewGuid().ToString("N")

try {
  @'
param([string] $Title)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 640
$form.Height = 360
$editor = New-Object System.Windows.Forms.TextBox
$editor.Name = "ZenXSmokeEditor"
$editor.AccessibleName = "ZenX smoke editor"
$editor.Multiline = $true
$editor.SetBounds(24, 24, 560, 220)
$form.Controls.Add($editor)
[System.Windows.Forms.Application]::Run($form)
'@ | Set-Content -LiteralPath $fixtureScript -Encoding UTF8
  $fixture = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-STA",
    "-File", ('"' + $fixtureScript + '"'),
    "-Title", ('"' + $fixtureTitle + '"')
  ) -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $fixture.Refresh()
  } while ($fixture.MainWindowTitle -ne $fixtureTitle -and [DateTime]::UtcNow -lt $deadline)

  if ($fixture.MainWindowTitle -ne $fixtureTitle) {
    throw "The deterministic WinForms fixture did not expose its window before the smoke timeout."
  }

  & npx --no-install tsx ./src/main/windows-computer-smoke.ts --pid $fixture.Id --title $fixtureTitle
  if ($LASTEXITCODE -ne 0) {
    throw "The ZenX WinApp adapter/registry smoke failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -Force }
  Remove-Item -LiteralPath $fixtureScript -Force -ErrorAction SilentlyContinue
}
