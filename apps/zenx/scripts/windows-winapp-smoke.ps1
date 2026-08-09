$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "This smoke test must run on Windows."
}

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "WinApp CLI is missing. Install it with: winget install Microsoft.winappcli --source winget"
}

$artifactDirectory = Join-Path $env:TEMP ("zenx-winapp-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
$notepad = $null

try {
  $notepad = Start-Process notepad.exe -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $notepad.Refresh()
  } while ([string]::IsNullOrWhiteSpace($notepad.MainWindowTitle) -and [DateTime]::UtcNow -lt $deadline)

  if ([string]::IsNullOrWhiteSpace($notepad.MainWindowTitle)) {
    throw "Notepad did not expose a window title before the smoke timeout."
  }

  $windows = @(winapp ui list-windows --app $notepad.Id --json | ConvertFrom-Json)
  $target = @($windows | Where-Object {
    $_.processId -eq $notepad.Id -and $_.title -eq $notepad.MainWindowTitle
  })
  if ($target.Count -ne 1) {
    throw "Expected one exact Notepad HWND; found $($target.Count)."
  }

  $inspection = winapp ui inspect --window $target[0].hwnd --depth 8 --hide-disabled --hide-offscreen --json | ConvertFrom-Json
  if (@($inspection.windows).Count -ne 1) {
    throw "WinApp inspect did not return the exact Notepad window."
  }

  function Expand-WinAppElement([object[]] $roots) {
    $pending = [Collections.Generic.Stack[object]]::new()
    for ($index = $roots.Count - 1; $index -ge 0; $index--) { $pending.Push($roots[$index]) }
    while ($pending.Count -gt 0) {
      $element = $pending.Pop()
      $element
      $children = @($element.children)
      for ($index = $children.Count - 1; $index -ge 0; $index--) { $pending.Push($children[$index]) }
    }
  }

  $elements = @(Expand-WinAppElement @($inspection.windows[0].elements))
  $editor = $elements | Where-Object {
    $_.selector -and $_.type -match "Edit|TextBox|Document"
  } | Select-Object -First 1
  if (-not $editor) {
    throw "No semantic Notepad editor selector was found."
  }

  $probeText = "ZenX WinApp smoke " + [DateTime]::UtcNow.ToString("O")
  winapp ui set-value $editor.selector $probeText --window $target[0].hwnd --json | ConvertFrom-Json | Out-Null

  $screenshotPath = Join-Path $artifactDirectory "notepad.png"
  $capture = winapp ui screenshot --window $target[0].hwnd --output $screenshotPath --json | ConvertFrom-Json
  if ($capture.hwnd -ne $target[0].hwnd -or -not (Test-Path $screenshotPath)) {
    throw "The scoped screenshot did not confirm its HWND and artifact."
  }

  Write-Host "ZenX WinApp smoke passed: inspect, semantic set-value, and WGC-default scoped capture."
} finally {
  if ($notepad -and -not $notepad.HasExited) { Stop-Process -Id $notepad.Id -Force }
  Remove-Item -LiteralPath $artifactDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
