/** Local JSONL trial of the real strict Windows UIA backend through the model facade.
 * Run with tsx and --winapp <absolute path to the packaged winapp.exe>.
 * Only a disposable WinForms fixture is exposed; no user window is selectable. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { ModelReferenceRegistry } from "../../../src/model-references.js";
import {
  computerModelDefinition,
  decodeComputerArguments,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";
import { ComputerZenXCapabilityPackage } from "../src/main/capabilities/computer-provider.js";
import {
  WinAppStrictUiaComputerBackend,
  windowsStrictUiaCapabilityManifest,
} from "../src/main/capabilities/windows-strict-uia-provider.js";
import { waitForFile } from "../src/main/windows-packaged-uia-files.js";
import { WINDOWS_PACKAGED_UIA_FIXTURE } from "../src/main/windows-packaged-uia-fixture.js";

const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const owner = "computer-model-trial";
const epoch = randomUUID();
const refs = new ModelReferenceRegistry().scope(owner);
const controller = new AbortController();
const executableIndex = process.argv.indexOf("--winapp");
const executable =
  executableIndex < 0 ? undefined : process.argv[executableIndex + 1];
if (process.platform !== "win32" || !executable || !path.isAbsolute(executable))
  throw Error("Windows requires --winapp <absolute packaged winapp.exe path>");

const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-computer-model-"));
const title = `ZenX model trial ${randomUUID()}`;
const script = path.join(directory, "fixture.ps1");
let fixture: ChildProcess | undefined;
let fixtureClosed: Promise<void> | undefined;
let computer: ComputerZenXCapabilityPackage | undefined;
let fixtureEnded = false;
let fixtureDiagnostic = "";
try {
  await writeFile(script, WINDOWS_PACKAGED_UIA_FIXTURE, "utf8");
  fixture = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      "target",
      "-Directory",
      directory,
      "-Title",
      title,
    ],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  fixtureClosed = new Promise<void>((resolve) => {
    fixture!.once("close", () => resolve());
  });
  for (const stream of [fixture.stdout, fixture.stderr])
    stream?.on("data", (bytes: Buffer) => {
      fixtureDiagnostic = (fixtureDiagnostic + bytes.toString("utf8")).slice(
        -8192,
      );
    });
  fixture.on("error", (error) => {
    fixtureDiagnostic += String(error);
  });
  fixture.on("close", () => {
    fixtureEnded = true;
  });
  const fixtureGuard = {
    assertRunning() {
      assert.equal(fixtureEnded, false, fixtureDiagnostic);
    },
    diagnostic() {
      return fixtureDiagnostic;
    },
  };
  const native = JSON.parse(
    await waitForFile(directory, "target.json", controller.signal, [
      fixtureGuard,
    ]),
  ) as { pid: number; title: string; messageLoopReady: boolean };
  assert.equal(native.messageLoopReady, true);
  assert.equal(native.title, title);
  const backend = new WinAppStrictUiaComputerBackend({
    command: executable,
    platform: "win32",
    bindBeforeSpawn: async () => async () => {},
  });
  computer = new ComputerZenXCapabilityPackage(
    backend,
    windowsStrictUiaCapabilityManifest,
  );
  const diagnosis = await backend.diagnose(controller.signal);
  assert.equal(diagnosis.ready, true, diagnosis.message);
  const exact = () => ({ pid: native.pid, windowTitle: title });
  const listFixture = async () => {
    const result = await backend.listWindows(title, controller.signal);
    const matches = result.windows.filter(
      (item) =>
        item.target.pid === native.pid && item.target.windowTitle === title,
    );
    assert.equal(
      matches.length,
      1,
      "Fixture must resolve to one native window",
    );
    return projectComputerResult(
      { ...result, windows: matches, truncated: false },
      {},
      refs,
      epoch,
    );
  };
  const windows = await listFixture();
  print({
    ready: true,
    fixture: "disposable native WinForms window",
    windows,
    tools: windowsStrictUiaCapabilityManifest.tools
      .filter((tool) =>
        [
          "computer_list_windows",
          "computer_inspect",
          "computer_press",
          "computer_set_value",
        ].includes(tool.name),
      )
      .map((tool) => computerModelDefinition(tool)),
  });
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as { tool?: unknown; args?: unknown };
      if (request.tool === "exit") break;
      if (
        typeof request.tool !== "string" ||
        ![
          "computer_list_windows",
          "computer_inspect",
          "computer_press",
          "computer_set_value",
        ].includes(request.tool)
      )
        throw Error("Only listed fixture Computer tools are available");
      if (
        !request.args ||
        typeof request.args !== "object" ||
        Array.isArray(request.args)
      )
        throw Error("args must be an object");
      if (request.tool === "computer_list_windows") {
        print({ tool: request.tool, result: await listFixture() });
        continue;
      }
      const args = decodeComputerArguments(
        request.tool,
        request.args as Record<string, unknown>,
        refs,
        epoch,
      );
      const target = args.target as { pid?: number; windowTitle?: string };
      if (target.pid !== native.pid || target.windowTitle !== title)
        throw Error("Only the disposable fixture window may be targeted");
      const result = await computer.invoke(request.tool, {
        name: request.tool,
        callId: randomUUID(),
        threadId: owner,
        cwd: directory,
        arguments: args,
        signal: controller.signal,
      });
      print({
        tool: request.tool,
        result: projectComputerResult(
          result as Record<string, unknown>,
          args,
          refs,
          epoch,
        ),
      });
    } catch (error) {
      print({ error: error instanceof Error ? error.message : String(error) });
    }
  }
} catch (error) {
  print({ fatal: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  controller.abort();
  await computer?.close();
  if (fixture && !fixtureEnded) {
    fixture.kill();
    await fixtureClosed;
  }
  await rm(directory, { recursive: true, force: true });
}
