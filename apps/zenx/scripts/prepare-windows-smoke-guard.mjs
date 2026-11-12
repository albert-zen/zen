import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const run = promisify(execFile);
const sourceName = "WINDOWS_FOREGROUND_GUARD_SOURCE";
const sourcePlaceholder = "__ZENX_WINDOWS_GUARD_SOURCE_SHA256__";
const assemblyPlaceholder = "__ZENX_WINDOWS_GUARD_ASSEMBLY_SHA256__";

/** Parse literals only: packaging must never execute a staged Electron bundle. */
export function extractWindowsGuardSource(source) {
  const file = ts.createSourceFile(
    "staged-main.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(file.parseDiagnostics.length, 0, "invalid staged JavaScript");
  const found = [];
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === sourceName
    ) {
      assert.ok(
        node.parent.flags & ts.NodeFlags.Const,
        "guard source must be a constant",
      );
      const value = node.initializer;
      assert.ok(
        value &&
          ts.isTaggedTemplateExpression(value) &&
          ts.isPropertyAccessExpression(value.tag) &&
          ts.isIdentifier(value.tag.expression) &&
          value.tag.expression.text === "String" &&
          value.tag.name.text === "raw" &&
          ts.isNoSubstitutionTemplateLiteral(value.template),
        "guard source must be one non-interpolated String.raw literal",
      );
      // ECMAScript template raw values normalize CR/CRLF to LF, unlike rawText.
      found.push(value.template.rawText.replace(/\r\n?/g, "\n"));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found.length <= 1, "duplicate guard source literals");
  if (found.length) assert.ok(found[0].length > 0, "empty guard source");
  return found[0];
}

async function stagedJavaScript(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await stagedJavaScript(file)));
    else if (entry.isFile() && file.endsWith(".js")) files.push(file);
  }
  return files.sort();
}

/** Only a Windows smoke run owns this artifact; it is never copied into app/resources. */
export async function prepareWindowsSmokeGuard(options) {
  if (
    (options.platform ?? process.platform) !== "win32" ||
    options.target !== "smoke"
  )
    return undefined;
  const candidates = [];
  let sourceMarkers = 0;
  let assemblyMarkers = 0;
  for (const file of await stagedJavaScript(options.mainDirectory)) {
    const bundle = await readFile(file, "utf8");
    const source = extractWindowsGuardSource(bundle);
    sourceMarkers += bundle.split(sourcePlaceholder).length - 1;
    assemblyMarkers += bundle.split(assemblyPlaceholder).length - 1;
    if (source !== undefined) candidates.push({ file, bundle, source });
  }
  assert.equal(
    candidates.length,
    1,
    "staged smoke must contain exactly one guard source",
  );
  assert.equal(
    sourceMarkers,
    1,
    "staged smoke must contain one source digest placeholder",
  );
  assert.equal(
    assemblyMarkers,
    1,
    "staged smoke must contain one assembly digest placeholder",
  );
  const { file, bundle, source } = candidates[0];
  assert.ok(
    bundle.includes(sourcePlaceholder) && bundle.includes(assemblyPlaceholder),
    "guard source and digest placeholders must share the same staged bundle",
  );
  const directory = await mkdtemp(
    path.join(options.stagingDirectory, "windows-smoke-guard-"),
  );
  const sourcePath = path.join(directory, "guard.cs");
  const assemblyPath = path.join(directory, "guard.dll");
  try {
    await writeFile(sourcePath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await (options.compile ?? compileWindowsGuard)(sourcePath, assemblyPath);
    const assembly = await readFile(assemblyPath);
    assert.ok(assembly.length > 0, "compiler produced an empty guard assembly");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const assemblySha256 = createHash("sha256").update(assembly).digest("hex");
    await writeFile(
      file,
      bundle
        .replace(sourcePlaceholder, sourceSha256)
        .replace(assemblyPlaceholder, assemblySha256),
    );
    // The containing package run retains only the DLL until smoke settles, then
    // removes its entire private staging in packageZenX's existing finally.
    return { path: assemblyPath, sourceSha256, assemblySha256 };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(sourcePath, { force: true });
  }
}

// Same Windows PowerShell/.NET Framework compiler and references as the former
// in-child compilation. Compilation never calls Run or creates a guard window.
const compileScript = String.raw`param([string] $SourcePath, [string] $AssemblyPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$source = [System.IO.File]::ReadAllText($SourcePath)
Add-Type -ReferencedAssemblies System,System.Drawing,System.Windows.Forms,System.Web.Extensions -TypeDefinition $source -OutputAssembly $AssemblyPath -OutputType Library
`;

export async function compileWindowsGuard(sourcePath, assemblyPath) {
  const script = path.join(path.dirname(sourcePath), "compile.ps1");
  try {
    await writeFile(script, compileScript, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await run(
      "powershell.exe",
      ["-NoProfile", "-STA", "-File", script, sourcePath, assemblyPath],
      { windowsHide: true, timeout: 60_000 },
    );
  } finally {
    await rm(script, { force: true });
  }
}
