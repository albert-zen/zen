import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Compilation only. The owned receiver supports an explicitly authorized native
// desktop trial; this test never launches it or posts events to an OS desktop.
test(
  "owned native drag receiver fixture compiles without running desktop input",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-drag-receiver-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync(
      "/usr/bin/swiftc",
      [
        fileURLToPath(
          new URL(
            "../evals/browser-computer/macos-native-fixture.swift",
            import.meta.url,
          ),
        ),
        "-o",
        path.join(directory, "receiver"),
      ],
      { encoding: "utf8", timeout: 45_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  },
);

// Linux-safe lifecycle contract only; it is not native activation evidence.
test("owned receiver uses background-launched regular app lifecycle without self-activation", () => {
  const fixture = readFileSync(
    new URL(
      "../evals/browser-computer/macos-native-fixture.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const acceptance = readFileSync(
    new URL("./computer-owned-native-acceptance.test.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    fixture.indexOf("setActivationPolicy(.regular)") <
      fixture.indexOf("application.run()"),
  );
  assert.match(fixture, /window\.makeKeyAndOrderFront\(nil\)/);
  assert.doesNotMatch(
    fixture,
    /setActivationPolicy\(\.accessory\)|\b(?:NSApp|application)\.activate\(/,
  );
  assert.doesNotMatch(fixture, /window\.orderFrontRegardless\(\)/);
  assert.match(
    acceptance,
    /"CFBundlePackageType"|<key>CFBundlePackageType<\/key>/,
  );
  assert.match(acceptance, /background \? \["-g"\] : \[\]/);
  assert.match(
    acceptance,
    /assert\.notEqual\(\s*preflight\.receiver\.frontmostPID,\s*ready\.pid/,
  );
  assert.match(acceptance, /assert\.equal\(afterAcquisition\.isActive, true\)/);
});

// A successful open waiter exit never proves that the app reached startup.
test("owned receiver records startup independently and treats regular policy idempotently", () => {
  const fixture = readFileSync(
    new URL(
      "../evals/browser-computer/macos-native-fixture.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const acceptance = readFileSync(
    new URL("./computer-owned-native-acceptance.test.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    fixture,
    /if initialPolicy != \.regular \{ policySwitchAccepted = application\.setActivationPolicy\(\.regular\) \}/,
  );
  assert.match(
    fixture,
    /guard application\.activationPolicy\(\) == \.regular else/,
  );
  assert.ok(
    fixture.indexOf('"owned-receiver-starting"') <
      fixture.indexOf("let application = NSApplication.shared"),
  );
  assert.match(fixture, /FileHandle\(forWritingAtPath: path\)/);
  assert.match(acceptance, /"--events-file",\s*eventsPath/);
  assert.match(acceptance, /const stopped =\s*launcherStopped &&/);
  assert.match(acceptance, /message\.kind === "owned-receiver-terminating"/);
  assert.doesNotMatch(fixture, /guard application\.setActivationPolicy/);
});

test("owned acquisition starts from fresh observed distractor focus and ends at receiver", () => {
  const fixture = readFileSync(
    new URL(
      "../evals/browser-computer/macos-native-fixture.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const acceptance = readFileSync(
    new URL("./computer-owned-native-acceptance.test.ts", import.meta.url),
    "utf8",
  );
  assert.match(fixture, /delegate\.reportFocus\("probe", token: token\)/);
  assert.match(
    acceptance,
    /receiverFixture\.probe\(\),\s*distractorFixture\.probe\(\)/,
  );
  assert.match(acceptance, /receiverState\.isActive === false/);
  assert.match(acceptance, /distractorState\.isActive === true/);
  assert.match(acceptance, /distractorState\.isKeyWindow === true/);
  assert.match(
    acceptance,
    /assert\.equal\(afterAcquisition\.frontmostPID, ready\.pid\)/,
  );
  assert.match(
    acceptance,
    /assert\.equal\(afterAcquisition\.isKeyWindow, true\)/,
  );
  assert.match(
    acceptance,
    /for \(const close of fixtureClosers\.reverse\(\)\) await close\(\)/,
  );
});

test("occluder identity diagnostic is exact-PID read-only and excludes private paths", () => {
  const fixture = readFileSync(
    new URL(
      "../evals/browser-computer/macos-native-fixture.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const start = fixture.indexOf('if let rawPID = argument("--inspect-pid")');
  const end = fixture.indexOf(
    'report(["kind": "owned-receiver-starting"',
    start,
  );
  const diagnostic = fixture.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(diagnostic, /NSRunningApplication\(processIdentifier: pid\)/);
  assert.match(diagnostic, /lastPathComponent/);
  assert.match(diagnostic, /let processPathCapacity = 4096/);
  assert.match(
    diagnostic,
    /proc_pidpath\(pid, &buffer, UInt32\(processPathCapacity\)\)/,
  );
  assert.doesNotMatch(diagnostic, /PROC_PIDPATHINFO_MAXSIZE/);
  assert.doesNotMatch(
    diagnostic,
    /runningApplications|localizedName|NSApplication\.shared|activate\(|terminate\(|CGWindowList|AXUIElement/,
  );
  assert.doesNotMatch(
    diagnostic,
    /identity\["(?:path|executableURL|bundleURL)"\]/,
  );
  assert.match(diagnostic, /later_exact_pid_read_not_lifetime_binding/);
  assert.ok(end < fixture.indexOf("let application = NSApplication.shared"));
});
