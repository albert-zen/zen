import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWindowsShellStartupFacts,
  windowsShellStartupProbe,
} from "./fixtures/windows-shell-startup-probe.js";

test("startup facts preserve Windows and Unicode paths without module-based JSON serialization", () => {
  const facts = {
    version: "5.1.26100.1",
    executable:
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    profile0: "C:\\用户\\profile.ps1\tFalse",
    modulePath: "C:\\Modules;D:\\Other Modules",
    empty: "",
  };
  const encoded = Object.entries(facts)
    .map(([key, value]) => `${key}=${Buffer.from(value).toString("base64")}`)
    .join("\r\n");
  assert.deepEqual(parseWindowsShellStartupFacts(encoded), facts);
  for (const invalid of ["", "version=YWJj\nversion=ZGVm", "not a fact"])
    assert.throws(
      () => parseWindowsShellStartupFacts(invalid),
      /Invalid or duplicate/,
    );
});

test("startup facts reject truncated Base64, noncanonical padding and invalid UTF-8", () => {
  for (const invalid of ["version=A", "version=Zg=", "version=////"])
    assert.throws(() => parseWindowsShellStartupFacts(invalid));
});

test("the phase probe uses a literal metadata path and no Utility or security-setting commands", () => {
  const source = windowsShellStartupProbe("C:\\fixture's dir\\metadata.txt");
  assert(source.includes("'C:\\fixture''s dir\\metadata.txt'"));
  assert(
    source.indexOf("ZEN_SHELL_STARTUP_ENGINE_READY") <
      source.indexOf("Import-Module PSReadLine"),
  );
  assert.match(source, /Import-Module PSReadLine -PassThru -ErrorAction Stop/u);
  assert.doesNotMatch(
    source,
    /ConvertTo-Json|Write-Output|Set-ExecutionPolicy|Set-ItemProperty|Remove-Module/u,
  );
});
