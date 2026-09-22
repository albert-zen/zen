import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileMacNativeHelpers } from "./package-zenx-portable.mjs";

const arguments_ = process.argv.slice(2);
const pid = positiveInteger(argumentValue(arguments_, "--pid"), "--pid");
const windowTitle = requiredArgument(arguments_, "--window-title");
const exercise = arguments_.includes("--exercise");
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "zenx-ax-probe-"),
);

try {
  const helperDirectory = path.join(temporaryDirectory, "native-helpers");
  const providerSource = await readFile(
    new URL("../src/main/capabilities/computer-provider.ts", import.meta.url),
    "utf8",
  );
  const probeMarker = providerSource.match(
    /  if !help\.isEmpty \{ result\[[^\n]+\}/u,
  )?.[0];
  if (exercise && probeMarker === undefined) {
    throw new Error("could not add fixture-only AX value observation");
  }
  const probeSource = exercise
    ? providerSource.replace(
        probeMarker,
        `${probeMarker}\n  let value = textAttribute(element, kAXValueAttribute)\n  if !value.isEmpty { result[\\"value\\"] = value }`,
      )
    : providerSource;
  await compileMacNativeHelpers({
    destinationDirectory: helperDirectory,
    providerSource: probeSource,
  });
  const helper = path.join(helperDirectory, "zenx-accessibility");
  let result = JSON.parse(
    await runHelper(helper, {
      operation: "inspect",
      target: { pid, windowTitle },
    }),
  );
  let exerciseResult;
  if (exercise) {
    const field = findControl(result.controls, "AXTextField", "协作文本");
    const button = findControl(result.controls, "AXButton", "更新结果");
    const value = "ZenX AX 语义写入验收";
    const setValue = JSON.parse(
      await runHelper(helper, {
        operation: "setValue",
        target: { pid, windowTitle },
        control: field.selector,
        value,
      }),
    );
    await runHelper(helper, {
      operation: "press",
      target: { pid, windowTitle },
      control: button.selector,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result = JSON.parse(
      await runHelper(helper, {
        operation: "inspect",
        target: { pid, windowTitle },
      }),
    );
    exerciseResult = {
      setValueCharacterCount: setValue.characterCount,
      resultTextObserved: result.controls?.some(
        (control) =>
          control?.role === "AXStaticText" &&
          control?.selector?.value === value,
      ),
    };
  }
  const fixtureLabels =
    /多标签验收|协作文本|更新结果|等待更新|本机多标签协作测试|ZenX AX 语义写入验收/u;
  const fixtureControls = Array.isArray(result.controls)
    ? result.controls
        .map((control, index) => ({ control, index }))
        .filter(
          ({ control }) =>
            control &&
            typeof control === "object" &&
            (fixtureLabels.test(String(control.title ?? "")) ||
              fixtureLabels.test(String(control.selector?.value ?? ""))),
        )
        .map(({ control, index }) => ({
          index,
          role: control.role,
          title: control.title,
          ...(control.selector?.value === undefined
            ? {}
            : { value: control.selector.value }),
          enabled: control.enabled,
          actions: control.actions,
        }))
    : [];
  process.stdout.write(
    `${JSON.stringify(
      {
        target: {
          pid: result.target?.pid,
          windowTitle: result.target?.windowTitle,
        },
        diagnostics: {
          ...result.diagnostics,
          selectionLimit: 32,
          selectionLimitReached:
            Array.isArray(result.controls) && result.controls.length > 32,
        },
        fixtureControls,
        ...(exerciseResult === undefined ? {} : { exercise: exerciseResult }),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function requiredArgument(arguments_, name) {
  const value = argumentValue(arguments_, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function findControl(controls, role, title) {
  const matches = Array.isArray(controls)
    ? controls.filter(
        (control) => control?.role === role && control?.title === title,
      )
    : [];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${role} titled ${title}; found ${String(matches.length)}`,
    );
  }
  return matches[0];
}

function runHelper(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("macOS accessibility probe timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `macOS accessibility probe exited with ${String(code)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(JSON.stringify(request));
  });
}
