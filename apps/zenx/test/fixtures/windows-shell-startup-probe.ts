/** No Utility-module commands: measuring its discovery would contaminate this control. */
export function windowsShellStartupProbe(metadataFile: string): string {
  return `
$ErrorActionPreference = 'Stop'
$facts = [Collections.Generic.List[string]]::new()
function Add-Fact($key, $value) {
  $facts.Add($key + '=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
function Save-Facts {
  [IO.File]::WriteAllLines('${metadataFile.replaceAll("'", "''")}', [string[]]$facts, [Text.UTF8Encoding]::new($false))
}
try {
  [Console]::WriteLine('ZEN_SHELL_STARTUP_ENGINE_READY')
  Add-Fact 'version' $PSVersionTable.PSVersion
  Add-Fact 'edition' $PSVersionTable.PSEdition
  Add-Fact 'executable' ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  Add-Fact 'psHome' $PSHOME
  Add-Fact 'dotnetVersion' ([Environment]::Version)
  Add-Fact 'modulePath' $env:PSModulePath
  $index = 0
  foreach ($profilePath in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {
    Add-Fact ('profile' + $index) ($profilePath + [char]9 + [IO.File]::Exists($profilePath))
    $index++
  }
  Save-Facts
  if (@(Get-Module PSReadLine).Count -ne 0) {
    throw 'PSReadLine was already loaded before the controlled import'
  }
  [Console]::WriteLine('ZEN_SHELL_STARTUP_READLINE_IMPORT_STARTED')
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $readline = @(Import-Module PSReadLine -PassThru -ErrorAction Stop)
  $watch.Stop()
  if ($readline.Count -ne 1 -or $readline[0].Name -ne 'PSReadLine') {
    throw 'The controlled import did not return one PSReadLine module'
  }
  Add-Fact 'readlineImportMs' $watch.ElapsedMilliseconds
  Add-Fact 'readlineVersion' $readline[0].Version
  Add-Fact 'readlinePath' $readline[0].Path
  Save-Facts
  [Console]::WriteLine('ZEN_SHELL_STARTUP_READLINE_IMPORTED')
  exit 0
} catch {
  Add-Fact 'error' $_.Exception.Message
  Save-Facts
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;
}

export function parseWindowsShellStartupFacts(source: string) {
  const facts: Record<string, string> = {};
  for (const line of source.trim().split(/\r?\n/u)) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*)=([a-zA-Z0-9+/]*={0,2})$/u.exec(line);
    if (!match || Object.hasOwn(facts, match[1]!))
      throw new Error("Invalid or duplicate Windows startup diagnostic fact");
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.toString("base64") !== match[2])
      throw new Error("Noncanonical Base64 Windows startup diagnostic fact");
    facts[match[1]!] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return facts;
}
