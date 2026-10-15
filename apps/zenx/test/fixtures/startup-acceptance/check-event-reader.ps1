param([string] $HarnessPath, [string] $NodeExecutable)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @("Open-SharedTextReader", "Read-SharedText", "Read-Events")) {
  $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($functions.Count -ne 1) { throw "Missing unique helper $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
function Assert-True($Value, $Message) { if (!$Value) { throw $Message } }
$directory = Join-Path ([IO.Path]::GetTempPath()) ("zenx-event-reader-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $directory | Out-Null
$file = Join-Path $directory "events-123.jsonl"
$utf8 = [Text.UTF8Encoding]::new($false)
# This independent helper check does not consume the existing process/Win32 mock budget.
$append = 'const fs = require("node:fs"); try { fs.appendFileSync(process.argv[1], JSON.stringify({type:"appended"})+"\n"); process.stdout.write("appended"); } catch (error) { process.stdout.write(error.code); if (error.code !== "EBUSY") process.exitCode = 1; }'
try {
  [IO.File]::WriteAllText($file, "{`"type`":`"initial`"}`n", $utf8)
  # ReadAllText uses this same default StreamReader(path) FileShare.Read mode.
  $oldReader = [IO.StreamReader]::new($file)
  try {
    $blocked = & $NodeExecutable -e $append $file
    Assert-True ($LASTEXITCODE -eq 0 -and $blocked -eq "EBUSY") "The old reader must demonstrate the real Windows append conflict"
  } finally { $oldReader.Dispose() }
  $reader = Open-SharedTextReader $file
  try {
    $written = & $NodeExecutable -e $append $file
    Assert-True ($LASTEXITCODE -eq 0 -and $written -eq "appended") "The actual shared reader must allow an independent Node append while open"
  } finally { $reader.Dispose() }
  $events = @(Read-Events $directory 123)
  Assert-True ($events.Count -eq 2 -and $events[0].type -eq "initial" -and $events[1].type -eq "appended") "Both completed event lines must survive"
  [IO.File]::AppendAllText($file, '{"type":"partial', $utf8)
  Assert-True (@(Read-Events $directory 123).Count -eq 2) "An incomplete final append must remain unaccepted"
  [IO.File]::AppendAllText($file, '"}' + "`n", $utf8)
  Assert-True (@(Read-Events $directory 123).Count -eq 3) "The completed final append must become visible"
  [IO.File]::AppendAllText($file, "{broken}`n", $utf8)
  $rejected = $false
  try { Read-Events $directory 123 | Out-Null } catch { $rejected = $true }
  Assert-True $rejected "A malformed completed line must still fail"
  # Both successful and parse-failure paths must leave no retained read handle.
  $exclusive = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $exclusive.Dispose()
  Write-Host "Startup event reader sharing checks passed (real Windows handles and independent Node writer)."
} finally {
  Remove-Item -LiteralPath $directory -Recurse -Force
}
