import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  prepareSecurityClosure,
  validatePreparedClosure,
  validateSecurityResolution,
} from "../../../scripts/prepare-zenx-winapp-security-closure.mjs";

const lock = JSON.parse(
  await readFile(
    new URL("../../../vendor/winapp-0.3.1/source.lock.json", import.meta.url),
    "utf8",
  ),
);
const candidate = { ...lock, dotnetSdk: "10.0.403", runtimeVersion: "10.0.14" };
const framework = "net10.0-windows10.0.19041";
// Synthetic shape only. No fixture hash is exported as a real NuGet closure.
const compiler = { resolved: "10.0.14", requested: "[10.0.14, )" };
const closure = {
  version: 2,
  dependencies: {
    [framework]: {
      "Microsoft.DotNet.ILCompiler": compiler,
      "Microsoft.NET.ILLink.Tasks": { resolved: "10.0.14" },
    },
    [`${framework}/win-x64`]: {
      "Microsoft.DotNet.ILCompiler": {
        ...compiler,
        dependencies: {
          "runtime.win-x64.Microsoft.DotNet.ILCompiler": "10.0.14",
        },
      },
      "runtime.win-x64.Microsoft.DotNet.ILCompiler": { resolved: "10.0.14" },
    },
  },
};
const bytes = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`.replaceAll("\n", "\r\n"));

test("preparation rejects old compiler, linker, host package and target group", () => {
  assert.equal(validatePreparedClosure(bytes(closure)).packageCount, 4);
  for (const group of Object.keys(closure.dependencies)) {
    for (const name of Object.keys(closure.dependencies[group])) {
      const changed = structuredClone(closure);
      changed.dependencies[group][name].resolved = "10.0.12";
      assert.throws(() => validatePreparedClosure(bytes(changed)));
    }
  }
  const changed = structuredClone(closure);
  changed.dependencies[`${framework}/win-arm64`] = {};
  assert.throws(() => validatePreparedClosure(bytes(changed)));
  assert.throws(() =>
    validatePreparedClosure(Buffer.from(JSON.stringify(closure))),
  );
});

const resolution = {
  Properties: {
    TargetFramework: "net10.0-windows10.0.19041.0",
    RuntimeIdentifier: "win-x64",
    SelfContained: "true",
    PublishAot: "true",
    NuGetAudit: "true",
    NuGetAuditMode: "all",
    TreatWarningsAsErrors: "true",
    NoWarn: "",
    WarningsNotAsErrors: "",
  },
  Items: {
    RuntimeFramework: [
      { Identity: "Microsoft.NETCore.App", Version: "10.0.14" },
    ],
    RuntimePack: [
      {
        Identity: "Microsoft.NETCore.App.Runtime.win-x64",
        FrameworkName: "Microsoft.NETCore.App",
        RuntimeIdentifier: "win-x64",
        NuGetPackageVersion: "10.0.14",
      },
    ],
    NuGetAuditSuppress: [],
  },
};

test("preparation preserves runtime, RID, AOT and vulnerability audit gates", () => {
  assert.equal(
    validateSecurityResolution(JSON.stringify(resolution), candidate)
      .runtimeVersion,
    "10.0.14",
  );
  for (const [key, value] of [
    ["NuGetAudit", "false"],
    ["NuGetAuditMode", "direct"],
    ["TreatWarningsAsErrors", "false"],
    ["NoWarn", "NU1903"],
    ["WarningsNotAsErrors", "NU1903"],
    ["PublishAot", "false"],
    ["RuntimeIdentifier", "win-arm64"],
  ]) {
    const changed = structuredClone(resolution);
    changed.Properties[key] = value;
    assert.throws(() =>
      validateSecurityResolution(JSON.stringify(changed), candidate),
    );
  }
  const suppressed = structuredClone(resolution);
  suppressed.Items.NuGetAuditSuppress = [
    { Identity: "https://example.invalid/advisory" },
  ];
  assert.throws(() =>
    validateSecurityResolution(JSON.stringify(suppressed), candidate),
  );
});

test("preparation push is branch-scoped and manual native review stays default", async () => {
  const workflow = await readFile(
    new URL(
      "../../../.github/workflows/zenx-winapp-downstream.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /prepare_security_closure:[\s\S]*?default: false/u);
  assert.match(
    workflow,
    /native-build:\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.prepare_security_closure \}\}/u,
  );
  assert.match(
    workflow,
    /prepare-security-closure:\s+if: \$\{\{ github\.event_name == 'push' \|\| inputs\.prepare_security_closure \}\}/u,
  );
  assert.match(
    workflow,
    /push:\s+branches:\s+- diagnostic\/winapp-patched-closure-20261104\s+paths:/u,
  );
  assert.match(workflow, /dotnet --list-sdks/u);
  assert.match(workflow, /steps\.existing-sdk\.outputs\.found != 'true'/u);
  const producer = await readFile(
    new URL(
      "../../../scripts/build-zenx-winapp-downstream.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(producer, /--force-evaluate|--use-lock-file/u);
  assert.match(producer, /"--locked-mode"/u);
  assert.match(producer, /"--no-restore"/u);
});

test(
  "no cross-platform lock generation fallback",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(prepareSecurityClosure({}), /requires Windows/u);
  },
);
