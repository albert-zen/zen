import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const native = source
  .split("const MAC_NATIVE = String.raw`")[1]
  .split("`;\n\nconst WINDOWS_NATIVE")[0];
function swiftFunction(name) {
  const start = native.indexOf(`func ${name}(`);
  assert(start >= 0, `Missing native ${name}`);
  let depth = 0;
  for (let index = native.indexOf("{", start); index < native.length; index++) {
    if (native[index] === "{") depth++;
    if (native[index] === "}" && --depth === 0)
      return native.slice(start, index + 1);
  }
  throw new Error(`Unclosed native ${name}`);
}
const cooldown = Number(/let idleTitleCooldown = ([\d.]+)/.exec(native)?.[1]);

// This is a deterministic load model, not a claim to execute macOS AX on Linux.
// The exact Swift functions below are compiled and executed on the macOS job.
function loadModel({ cost = 0, duration = 3, interval = cooldown } = {}) {
  let now = 0,
    next = 0,
    titleCalls = 0,
    samples = 0;
  const calls = [];
  while (now < duration) {
    samples++;
    if (now >= next) {
      const started = now;
      now += cost;
      titleCalls++;
      calls.push({ started, completed: now });
      next = now + interval;
    }
    now += 0.01;
  }
  return { titleCalls, samples, calls };
}

test("idle AX work has an explicit completion-based 250ms cooldown", () => {
  assert.equal(cooldown, 0.25);
  assert.match(
    swiftFunction("sample"),
    /if !owns\(checkTitle: checkTitle\) \{ drift = true \}/,
  );
  assert.match(
    swiftFunction("sample"),
    /if checkTitle \{ nextIdleTitleSampleAt = ProcessInfo\.processInfo\.systemUptime \+ idleTitleCooldown \}/,
  );
  assert.match(
    swiftFunction("sampleIdle"),
    /sample\(checkTitle: ProcessInfo\.processInfo\.systemUptime >= nextIdleTitleSampleAt\)/,
  );
  assert.match(
    native,
    /Timer\.scheduledTimer\(withTimeInterval:0\.01,repeats:true\) \{ _ in sampleIdle\(\) \}/,
  );
});

test("idle fast reads no longer request AX at every 10ms timer tick", () => {
  const old = loadModel({ interval: 0 });
  const current = loadModel();
  assert(old.titleCalls >= 299);
  assert(current.titleCalls <= 12);
  assert(current.samples >= 299);
});

for (const cost of [0.015, 0.315, 1])
  test(`slow AX ${cost}s leaves a real quiet interval rather than catch-up polling`, () => {
    const old = loadModel({ cost, interval: 0, duration: 10 });
    const current = loadModel({ cost, duration: 10 });
    assert(current.titleCalls < old.titleCalls);
    for (let index = 1; index < current.calls.length; index++)
      assert(
        current.calls[index].started - current.calls[index - 1].completed >=
          0.25 - 1e-9,
      );
  });

test("cheap idle sampling always checks owner PID and sentinel focus before skipping title", () => {
  const owns = swiftFunction("owns");
  assert.match(owns, /checkTitle: Bool = true/);
  const pid = owns.indexOf("guard currentPid() == expectedPid");
  const sentinel = owns.indexOf("sentinel?.isKeyWindow");
  const skip = owns.indexOf("if !checkTitle { return true }");
  assert(pid >= 0 && sentinel > pid && skip > sentinel);
  assert.match(
    owns.slice(skip),
    /titleFor\(expectedPid\)\.contains\(expectedTitle\)/,
  );
});

test("snapshots, value barriers and each native event retain full uncached guards", () => {
  assert.match(swiftFunction("state"), /sample\(\)/);
  const type = native.slice(
    native.indexOf('  case "type":'),
    native.indexOf('  case "snapshot":'),
  );
  assert.match(type, /guard expectedPid != 0, !drift, owns\(\)/);
  assert.match(type, /\(value as\? String\) == expectedValue/);
  assert.match(
    type,
    /for down in \[true,false\] \{\s+sample\(\); guard !drift, owns\(\)/,
  );
  assert.doesNotMatch(
    type,
    /checkTitle: false|sampleIdle|nextIdleTitleSampleAt/,
  );
  const barrier = native.slice(
    native.indexOf('  case "focusedValue":'),
    native.indexOf('  case "type":'),
  );
  assert.match(barrier, /!drift, owns\(\)/);
  assert.match(barrier, /guard !drift, owns\(\) else/);
});

test("sampling never clears drift and historical activation owner latches an excursion", () => {
  assert.doesNotMatch(swiftFunction("sample"), /drift = false/);
  assert.doesNotMatch(swiftFunction("sampleIdle"), /drift = false/);
  assert.match(
    native,
    /notification\.userInfo\?\[NSWorkspace\.applicationUserInfoKey\].*activated\.processIdentifier != expectedPid \{ drift = true \}/,
  );
});

test("activation callbacks cannot revive or contaminate a retired guard epoch", () => {
  const reset = swiftFunction("resetGuard");
  assert.match(
    reset,
    /guardEpoch \+= 1[\s\S]+removeObserver\(previous\)[\s\S]+activationObserver = nil/,
  );
  assert.match(reset, /if pid == 0 \{ return \}/);
  assert.match(reset, /let epoch = guardEpoch/);
  const epochExpression =
    /guard (guardEpoch == epoch, expectedPid != 0) else \{ return \}/.exec(
      reset,
    )?.[1];
  const ownerExpression =
    /(activated\.processIdentifier != expectedPid) \{ drift = true \}/.exec(
      reset,
    )?.[1];
  assert(epochExpression && ownerExpression);
  const relevant = new Function(
    "guardEpoch",
    "epoch",
    "expectedPid",
    `return ${epochExpression.replace(",", "&&")};`,
  );
  const different = new Function(
    "activated",
    "expectedPid",
    `return ${ownerExpression};`,
  );
  let guardEpoch = 1,
    expectedPid = 7,
    drift = false;
  const callback = (epoch, activatedPid) => {
    if (!relevant(guardEpoch, epoch, expectedPid)) return;
    if (different({ processIdentifier: activatedPid }, expectedPid))
      drift = true;
  };
  callback(1, 8); // Historical other owner, while current foreground is already 7.
  assert(drift);
  callback(1, 7);
  assert(drift); // Returning does not clear the excursion.
  guardEpoch++;
  drift = false;
  callback(1, 8);
  assert.equal(drift, false); // A callback queued by the retired epoch is ignored.
  callback(2, 8);
  assert(drift);
  guardEpoch++;
  expectedPid = 0;
  drift = false;
  callback(2, 8);
  assert.equal(drift, false); // Cleanup cannot let old work alter the cleared state.
});

function pageScript() {
  const ast = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const page = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "page",
  );
  assert(page);
  const executable = ts.transpileModule(page.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const html = runInNewContext(`${executable}; page("user")`, {
    userTitle: "Owned user",
    agentTitle: "Owned agent",
  });
  return html.split("<script>")[1].split("</script>")[0];
}

test("actual fixture and guard reject returned focus but accept only a new explicit baseline", () => {
  const listeners = new Map();
  const window = {
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const document = { addEventListener() {} };
  const context = { window, document };
  Object.defineProperty(context, "fixture", { get: () => window.fixture });
  runInNewContext(pageScript(), context);
  assert(listeners.has("blur") && listeners.has("focus"));
  const ast = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let check;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "assert.deepEqual" &&
      node.arguments[0]?.getText(ast) === "userState.focusEvents"
    )
      check = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert(check, "The real guard must compare captured window focus history");
  const validate = new Function(
    "assert",
    "userState",
    "userBefore",
    check.getText(ast),
  );
  const state = () => ({ focusEvents: Array.from(window.fixture.focusEvents) });
  listeners.get("focus")({ target: window }); // Normal setup before the baseline.
  const baseline = state();
  listeners.get("focus")({ target: {} }); // Element focus is not window ownership.
  validate(assert, state(), baseline);
  listeners.get("blur")({ target: window });
  listeners.get("focus")({ target: window });
  assert.deepEqual(state().focusEvents, ["focus", "blur", "focus"]);
  assert.throws(
    () => validate(assert, state(), baseline),
    /User window focus changed/,
  );
  const newBaseline = state(); // Next scenario deliberately establishes its guard.
  validate(assert, state(), newBaseline);
  listeners.get("blur")({ target: window });
  assert.throws(
    () => validate(assert, state(), newBaseline),
    /User window focus changed/,
  );
});

function startupStatements() {
  const ast = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const main = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "main",
  );
  const statements = main.body.statements.find(ts.isTryStatement).tryBlock
    .statements;
  return { ast, statements };
}

test("startup baseline follows normal setup and precedes the first provider work", () => {
  const { ast, statements } = startupStatements();
  const text = statements.map((statement) => statement.getText(ast));
  const guard = text.findIndex((value) =>
    value.startsWith('await native.call("guard",'),
  );
  const baseline = text.findIndex((value) =>
    value.startsWith("const beforeOpen ="),
  );
  const connect = text.findIndex((value) =>
    value.startsWith("connection = await connectUserBrowserCdp("),
  );
  assert(guard >= 0 && baseline > guard && connect > baseline);
});

async function validateActualStartup(beforeOpen, afterOpen) {
  const { ast, statements } = startupStatements();
  const first = statements.findIndex((statement) =>
    statement.getText(ast).startsWith("const userWindow ="),
  );
  const last = statements.findIndex((statement) =>
    statement.getText(ast).startsWith("const scenarios ="),
  );
  assert(first >= 0 && last > first);
  // Execute the complete real startup validation, before the scenario loop can
  // clear native drift and record a fresh page baseline. No assertion is copied.
  const executable = ts.transpileModule(
    `async function validate() {
      ${statements
        .slice(first, last)
        .map((statement) => statement.getText(ast))
        .join("\n")}
    }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  await runInNewContext(`${executable}; validate()`, {
    assert,
    beforeOpen,
    stateScript: "owned fixture state",
    user: { id: "user" },
    opened: { tabId: "agent" },
    browserRpc: { send: async () => ({ windowId: 7 }) },
    userRpc: { evaluate: async () => afterOpen },
    agentRpc: { evaluate: async () => ({ visibility: "hidden" }) },
    native: {
      call: async (method) => {
        assert.equal(method, "snapshot");
        return { drift: false };
      },
    },
  });
}

const startupBaseline = () => ({
  focus: "user-input",
  hasFocus: true,
  visibility: "visible",
  // Normal setup is permitted to focus/activate before this baseline.
  focusEvents: ["blur", "focus"],
  visibilityEvents: ["hidden", "visible"],
});

test("actual startup validation accepts normal initialization without an excursion", async () => {
  await validateActualStartup(startupBaseline(), startupBaseline());
});

test("actual startup validation rejects a returned same-PID window excursion", async () => {
  const after = startupBaseline();
  after.focusEvents.push("blur", "focus");
  await assert.rejects(
    validateActualStartup(startupBaseline(), after),
    /User window focus changed during provider startup/,
  );
});

test("actual startup validation rejects a returned tab visibility excursion", async () => {
  const after = startupBaseline();
  after.visibilityEvents.push("hidden", "visible");
  await assert.rejects(
    validateActualStartup(startupBaseline(), after),
    /User tab visibility changed during provider startup/,
  );
});

test("actual startup validation requires current keyboard focus as well as history", async () => {
  await assert.rejects(
    validateActualStartup(startupBaseline(), {
      ...startupBaseline(),
      hasFocus: false,
    }),
    /User browser lost keyboard focus during provider startup/,
  );
});

test(
  "actual Swift sampling functions reject drift and bound slow-read load",
  { skip: process.platform !== "darwin" },
  () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-sampler-contract-"),
    );
    try {
      const harness = `
var clock = 0.0
struct ProcessInfo { static let processInfo = ProcessInfo(); var systemUptime: Double { clock } }
typealias pid_t = Int32
var expectedPid: pid_t = 7
var activePid: pid_t = 7
var expectedTitle = "owned"
var title = "owned"
var drift = false
var samples = 0
let idleTitleCooldown = ${cooldown}
var nextIdleTitleSampleAt = 0.0
var titleSamples = 0
var guardEpoch = 0
protocol NSObjectProtocol {}
class Observer: NSObjectProtocol {}
enum Queue { case main }
struct Notification { let userInfo: [String:Any]? }
class NSRunningApplication { let processIdentifier: pid_t; init(_ pid: pid_t) { processIdentifier = pid } }
class NotificationCenter {
  var callbacks: [(Notification) -> Void] = []
  func removeObserver(_ previous: NSObjectProtocol) {}
  func addObserver(forName: String, object: Any?, queue: Queue?, using callback: @escaping (Notification) -> Void) -> NSObjectProtocol { callbacks.append(callback); return Observer() }
}
class NSWorkspace {
  static let shared = NSWorkspace()
  static let didActivateApplicationNotification = "activation"
  static let applicationUserInfoKey = "application"
  let notificationCenter = NotificationCenter()
}
var activationObserver: NSObjectProtocol? = nil
var titleCalls = 0
var cost = 0.315
var starts: [Double] = []
var completions: [Double] = []
class Sentinel { var isKeyWindow = true }
class Field { func currentEditor() -> Int? { 1 } }
var sentinel: Sentinel? = Sentinel()
var field: Field? = Field()
func getpid() -> pid_t { 3 }
func currentPid() -> pid_t { activePid }
func AXIsProcessTrusted() -> Bool { true }
func titleFor(_ pid: pid_t) -> String { starts.append(clock); clock += cost; completions.append(clock); titleCalls += 1; return title }
${swiftFunction("owns")}
${swiftFunction("sample")}
${swiftFunction("sampleIdle")}
${swiftFunction("resetGuard")}
while clock < 3 { sampleIdle(); clock += 0.01 }
precondition(titleCalls <= 6 && titleCalls >= 5)
for i in 1..<starts.count { precondition(starts[i] - completions[i - 1] >= 0.249999) }
let before = titleCalls
nextIdleTitleSampleAt = clock + 100
sampleIdle()
precondition(titleCalls == before)
activePid = 8
sampleIdle()
precondition(drift)
activePid = 7
sampleIdle()
precondition(drift)
drift = false
title = "other window"
precondition(!owns())
sample()
precondition(drift && titleCalls == before + 2)
title = "owned"
sampleIdle()
precondition(drift)
expectedPid = getpid(); activePid = getpid(); sentinel!.isKeyWindow = false
drift = false
sampleIdle()
precondition(drift)
resetGuard(7, "owned"); activePid = 7
let historical = Notification(userInfo: ["application": NSRunningApplication(8)])
let oldCallback = NSWorkspace.shared.notificationCenter.callbacks.last!
oldCallback(historical)
precondition(drift)
resetGuard(7, "owned")
oldCallback(historical)
precondition(!drift)
let currentCallback = NSWorkspace.shared.notificationCenter.callbacks.last!
currentCallback(historical)
precondition(drift)
resetGuard()
currentCallback(historical)
precondition(!drift && expectedPid == 0)
print("actual Swift sampler contract passed")
`;
      const file = path.join(directory, "contract.swift"),
        binary = path.join(directory, "contract");
      writeFileSync(file, harness);
      execFileSync(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-swift-version",
          "5",
          "-module-cache-path",
          path.join(directory, "cache"),
          file,
          "-o",
          binary,
        ],
        { timeout: 60000, stdio: "pipe" },
      );
      assert.match(
        execFileSync(binary, { timeout: 10000, encoding: "utf8" }),
        /actual Swift sampler contract passed/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
