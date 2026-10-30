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
  assert.match(acceptance, /"-g",\s*"-n",\s*"-W"/);
  assert.match(
    acceptance,
    /assert\.notEqual\(\s*ready\.frontmostPID,\s*ready\.pid/,
  );
  assert.match(
    acceptance,
    /event\.isActive === true && event\.isKeyWindow === true/,
  );
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
  assert.match(acceptance, /receiverStopped =\s*launcherStopped &&/);
  assert.match(acceptance, /message\.kind === "owned-receiver-terminating"/);
  assert.doesNotMatch(fixture, /guard application\.setActivationPolicy/);
});
