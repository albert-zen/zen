import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  compileWindowsGuard,
  extractWindowsGuardSource,
  prepareWindowsSmokeGuard,
} from "../scripts/prepare-windows-smoke-guard.mjs";
import {
  readVerifiedWindowsGuardAssembly,
  startWindowsForegroundInputProbe,
  WINDOWS_FOREGROUND_GUARD_SOURCE,
  WINDOWS_FOREGROUND_GUARD,
  windowsGuardLoader,
} from "../src/main/windows-foreground-input-probe.ts";

const sourceMarker = "__ZENX_WINDOWS_GUARD_SOURCE_SHA256__";
const assemblyMarker = "__ZENX_WINDOWS_GUARD_ASSEMBLY_SHA256__";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
test("precompilation preserves every byte of the reviewed R2 C# guard", () => {
  // #409 R2: Run/Tick, SendInput, foreground/ownership checks, all durations,
  // and the fixed diagnostics are mechanically unchanged by the split.
  assert.equal(
    hash(WINDOWS_FOREGROUND_GUARD_SOURCE),
    "83e1b5f6fd9090a667cbfda3a36b313a90140775ccaf8c7ae64c01e0481612c5",
  );
});
const bundle = (source = WINDOWS_FOREGROUND_GUARD_SOURCE) =>
  `const WINDOWS_FOREGROUND_GUARD_SOURCE = String.raw\`${source}\`;\nconst sourceDigest = "${sourceMarker}";\nconst assemblyDigest = "${assemblyMarker}";\n`;

async function fixture(t, contents = bundle()) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-guard-build-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mainDirectory = path.join(directory, "app", "main");
  await mkdir(mainDirectory, { recursive: true });
  const main = path.join(mainDirectory, "guard.js");
  await writeFile(main, contents);
  return {
    directory,
    main,
    mainDirectory,
    options: {
      target: "smoke",
      platform: "win32",
      mainDirectory,
      stagingDirectory: directory,
    },
  };
}

test("statically extracts the literal without evaluating code, preserving raw escapes and normalizing CRLF", () => {
  assert.equal(
    extractWindowsGuardSource(bundle()),
    WINDOWS_FOREGROUND_GUARD_SOURCE,
  );
  assert.equal(
    extractWindowsGuardSource(
      "throw new Error('must not execute');\n" + bundle("a\\n\r\nb"),
    ),
    "a\\n\nb",
  );
  assert.equal(extractWindowsGuardSource("const unrelated = 1;"), undefined);
  for (const value of [
    "String.raw`a${input}`",
    "`cooked`",
    "functionCall()",
    "Other.raw`source`",
    "String.raw``",
  ]) {
    assert.throws(() =>
      extractWindowsGuardSource(
        `const WINDOWS_FOREGROUND_GUARD_SOURCE = ${value};`,
      ),
    );
  }
  assert.throws(
    () => extractWindowsGuardSource(bundle() + bundle()),
    /duplicate/,
  );
  assert.throws(
    () =>
      extractWindowsGuardSource(
        bundle().replace("const WINDOWS", "let WINDOWS"),
      ),
    /constant/,
  );
  assert.throws(() => extractWindowsGuardSource("const ! ="), /invalid staged/);
});

test("same-stage source is compiled once and both digests bind only the staged copy", async (t) => {
  const source =
    WINDOWS_FOREGROUND_GUARD_SOURCE + "// same-stage test marker\n";
  const f = await fixture(t, bundle(source));
  const immutable = path.join(f.directory, "build.js");
  await writeFile(immutable, bundle());
  const dll = Buffer.from("synthetic-compiled-stage");
  let calls = 0;
  const artifact = await prepareWindowsSmokeGuard({
    ...f.options,
    compile: async (sourcePath, assemblyPath) => {
      calls++;
      assert.equal(await readFile(sourcePath, "utf8"), source);
      assert.ok(!assemblyPath.startsWith(f.mainDirectory));
      await writeFile(assemblyPath, dll);
    },
  });
  assert.equal(calls, 1);
  assert.equal(artifact.sourceSha256, hash(source));
  assert.equal(artifact.assemblySha256, hash(dll));
  assert.equal(
    await readFile(f.main, "utf8"),
    bundle(source)
      .replace(sourceMarker, hash(source))
      .replace(assemblyMarker, hash(dll)),
  );
  assert.equal(await readFile(immutable, "utf8"), bundle());
  assert.deepEqual(await readdir(path.dirname(artifact.path)), ["guard.dll"]);
  assert.deepEqual(await readdir(f.mainDirectory), ["guard.js"]);
});

test("application and non-Windows targets never read, compile, or stage the guard", async () => {
  for (const [platform, target] of [
    ["win32", "app"],
    ["darwin", "smoke"],
    ["linux", "smoke"],
  ]) {
    assert.equal(
      await prepareWindowsSmokeGuard({
        platform,
        target,
        compile() {
          assert.fail("not a Windows smoke build");
        },
      }),
      undefined,
    );
  }
});

test("missing, duplicate, interpolated, split or already-bound staged contracts fail before compilation", async (t) => {
  for (const contents of [
    "const source = 1;",
    bundle() + bundle(),
    bundle().replace(sourceMarker, "a".repeat(64)),
    bundle().replace(assemblyMarker, ""),
    bundle() + `const extra = "${assemblyMarker}";`,
    bundle().replace(
      "String.raw`using System;",
      "String.raw`${unexpected}using System;",
    ),
  ]) {
    const f = await fixture(t, contents);
    await assert.rejects(
      prepareWindowsSmokeGuard({
        ...f.options,
        compile() {
          assert.fail("invalid bundle reached compiler");
        },
      }),
    );
    assert.equal(await readFile(f.main, "utf8"), contents);
    assert.deepEqual(await readdir(f.directory), ["app"]);
  }
  const f = await fixture(t, bundle().replace(assemblyMarker, "different"));
  await writeFile(
    path.join(f.mainDirectory, "other.js"),
    `const digest = "${assemblyMarker}";`,
  );
  await assert.rejects(
    prepareWindowsSmokeGuard({ ...f.options }),
    /same staged bundle/,
  );
});

test("compile, absent-output and empty-output failures clean staging and leave bundle unbound", async (t) => {
  for (const compile of [
    async () => {
      throw new Error("compiler failed");
    },
    async () => {},
    async (_source, output) => {
      await writeFile(output, "");
    },
  ]) {
    const f = await fixture(t);
    await assert.rejects(prepareWindowsSmokeGuard({ ...f.options, compile }));
    assert.equal(await readFile(f.main, "utf8"), bundle());
    assert.deepEqual(await readdir(f.directory), ["app"]);
  }
});

test("concurrent smoke stages never share a DLL or source identity", async (t) => {
  const fixtures = await Promise.all([fixture(t), fixture(t)]);
  const artifacts = await Promise.all(
    fixtures.map((f, i) =>
      prepareWindowsSmokeGuard({
        ...f.options,
        compile: async (_source, output) => writeFile(output, `synthetic-${i}`),
      }),
    ),
  );
  assert.notEqual(artifacts[0].path, artifacts[1].path);
  assert.notEqual(artifacts[0].assemblySha256, artifacts[1].assemblySha256);
  assert.equal(artifacts[0].sourceSha256, artifacts[1].sourceSha256);
});

test("runtime rejects missing/mismatched source and assembly before any child is spawned", async (t) => {
  const f = await fixture(t);
  const dll = Buffer.from("synthetic-node-child-assembly");
  const dllPath = path.join(f.directory, "guard.dll");
  await writeFile(dllPath, dll);
  const valid = {
    path: dllPath,
    sourceSha256: hash(WINDOWS_FOREGROUND_GUARD_SOURCE),
    assemblySha256: hash(dll),
  };
  assert.deepEqual(await readVerifiedWindowsGuardAssembly(valid), dll);
  for (const assembly of [
    { ...valid, sourceSha256: "f".repeat(64) },
    { ...valid, assemblySha256: "f".repeat(64) },
    { ...valid, sourceSha256: sourceMarker },
    { ...valid, assemblySha256: assemblyMarker },
    { ...valid, path: "relative.dll" },
    { ...valid, path: path.join(f.directory, "absent.dll") },
  ]) {
    await assert.rejects(
      startWindowsForegroundInputProbe({
        platform: "win32",
        assembly,
        spawnGuard() {
          assert.fail("invalid artifact reached child spawn");
        },
      }),
    );
  }
  // A source/development bundle has unbound digests; even a caller-supplied
  // environment path must never turn it into a runtime-compilation fallback.
  await assert.rejects(
    startWindowsForegroundInputProbe({
      platform: "win32",
      spawnGuard() {
        assert.fail("unbound bundle reached child spawn");
      },
    }),
    /missing same-build guard source digest/,
  );
});

test("probe copies verified bytes into its owned directory and embeds only the pinned digest", async (t) => {
  const f = await fixture(t);
  const dll = Buffer.from("synthetic-node-child-assembly");
  const dllPath = path.join(f.directory, "guard.dll");
  await writeFile(dllPath, dll);
  const assembly = {
    path: dllPath,
    sourceSha256: hash(WINDOWS_FOREGROUND_GUARD_SOURCE),
    assemblySha256: hash(dll),
  };
  let owned;
  const probe = await startWindowsForegroundInputProbe({
    platform: "win32",
    assembly,
    spawnGuard(script, directory) {
      owned = directory;
      assert.deepEqual(readFileSync(path.join(directory, "guard.dll")), dll);
      assert.equal(
        readFileSync(script, "utf8"),
        windowsGuardLoader(assembly.assemblySha256),
      );
      return spawn(process.execPath, [
        "-e",
        `
        const fs=require('node:fs'),path=require('node:path'),dir=process.argv[1];
        fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({kind:'windows-os-routed-input',phase:'ready',guardPid:process.pid,samples:1,sampledFocusChanges:0,foregroundEvents:[],injectedClicks:1,guardMouseDown:1,guardMouseUp:1}));
        const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'close'))){clearInterval(timer);process.exit(0);}},5);
      `,
        directory,
      ]);
    },
  });
  await probe.close();
  await assert.rejects(readFile(path.join(owned, "guard.dll")), {
    code: "ENOENT",
  });
});

test("runtime loader only loads its hash-verified byte array, with no compiler or path reload fallback", () => {
  assert.doesNotMatch(
    WINDOWS_FOREGROUND_GUARD,
    /TypeDefinition|OutputAssembly|LoadFrom|LoadFile|Add-Type -LiteralPath/,
  );
  assert.match(
    WINDOWS_FOREGROUND_GUARD,
    /Assembly\]::Load\(\[byte\[\]\]\$assemblyBytes\)/,
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.indexOf("ComputeHash($assemblyBytes)") <
      WINDOWS_FOREGROUND_GUARD.indexOf("Assembly]::Load"),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.indexOf(
      'throw "Native guard assembly digest mismatch"',
    ) < WINDOWS_FOREGROUND_GUARD.indexOf("Assembly]::Load"),
  );
  assert.throws(() => windowsGuardLoader('";unexpected'), /match/);
  const loader = windowsGuardLoader("a".repeat(64));
  assert.doesNotMatch(loader, /__ZENX_/);
  assert.equal(loader.split("a".repeat(64)).length, 2);
});

test(
  "Windows compiles exact source and loads the real DLL with Framework dependencies in a fresh PowerShell, without Run",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const f = await fixture(t);
    const artifact = await prepareWindowsSmokeGuard({
      ...f.options,
      compile: compileWindowsGuard,
    });
    const directory = path.dirname(artifact.path);
    const invocation =
      "[ZenXOverlayGuard]::Run($Directory,$ParentPid,$diagnosticClock)";
    const check = String.raw`
$type = [ZenXOverlayGuard]
if ($type.BaseType -ne [System.Windows.Forms.Form]) { throw "Wrong guard base type" }
$method = $type.GetMethod("Run",[Type[]]@([string],[int],[System.Diagnostics.Stopwatch]))
if ($null -eq $method -or !$method.IsStatic -or $method.ReturnType -ne [void]) { throw "Wrong guard Run signature" }
$names = @($type.Assembly.GetReferencedAssemblies() | ForEach-Object {
  [void][System.Reflection.Assembly]::Load($_.FullName)
  $_.Name
} | Sort-Object)
ConvertTo-Json -Compress @{ references=$names; pid=$PID }
`;
    const loader = windowsGuardLoader(artifact.assemblySha256).replace(
      invocation,
      check,
    );
    assert.ok(!loader.includes(invocation));
    const script = path.join(directory, "load-only.ps1");
    await writeFile(script, loader);
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-STA", "-File", script, directory, String(process.pid)],
      { windowsHide: true, timeout: 30_000 },
    );
    const proof = JSON.parse(stdout.trim());
    assert.ok(proof.pid > 0);
    assert.deepEqual(
      proof.references.sort(),
      [
        "System",
        "System.Drawing",
        "System.Web.Extensions",
        "System.Windows.Forms",
        "mscorlib",
      ].sort(),
    );
    const stages = await readFile(
      path.join(directory, "startup-stages.jsonl"),
      "utf8",
    );
    assert.match(stages, /assembly-loaded/);
    assert.doesNotMatch(stages, /managed-entry|form-|self-click|ready-written/);
    await writeFile(artifact.path, "tampered bytes");
    await assert.rejects(
      run(
        "powershell.exe",
        ["-NoProfile", "-STA", "-File", script, directory, String(process.pid)],
        { windowsHide: true, timeout: 30_000 },
      ),
      /digest mismatch/,
    );
  },
);
