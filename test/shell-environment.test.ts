import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute, join } from "node:path";
import {
  completeWindowsUserEnvironment,
  sanitizeToolEnvironment,
} from "../src/tool.js";

const PROFILE = "C:\\Users\\owner";

test("Windows shells derive the profile variables a GUI launch leaves out", () => {
  const environment = completeWindowsUserEnvironment(
    {
      PATH: "C:\\Windows\\system32",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: PROFILE,
    },
    { platform: "win32", home: "/unused" },
  );
  assert.equal(environment.HOME, PROFILE);
  assert.equal(environment.APPDATA, join(PROFILE, "AppData", "Roaming"));
  assert.equal(environment.LOCALAPPDATA, join(PROFILE, "AppData", "Local"));
  assert.equal(environment.TEMP, join(PROFILE, "AppData", "Local", "Temp"));
  assert.equal(environment.TMP, environment.TEMP);
  assert.equal(environment.HOMEDRIVE, "C:");
  assert.equal(environment.HOMEPATH, "\\Users\\owner");
  assert.equal(environment.SYSTEMDRIVE, "C:");
  // Completion only fills gaps in an already-allowlisted shell environment.
  assert.equal(environment.USERNAME, undefined);
});

test("inherited values win and gaps close from HOMEDRIVE/HOMEPATH", () => {
  const environment = completeWindowsUserEnvironment(
    {
      APPDATA: "D:\\roaming",
      HOMEDRIVE: "D:",
      HOMEPATH: "\\profiles\\owner",
      LOCALAPPDATA: "D:\\local",
      TEMP: "D:\\temp",
      TMP: "D:\\temp",
    },
    { platform: "win32", home: "/unused" },
  );
  assert.equal(environment.APPDATA, "D:\\roaming");
  assert.equal(environment.LOCALAPPDATA, "D:\\local");
  assert.equal(environment.TEMP, "D:\\temp");
  assert.equal(environment.HOME, "D:\\profiles\\owner");
  assert.equal(environment.USERPROFILE, "D:\\profiles\\owner");
});

test("a missing profile leaves the environment untouched", () => {
  const environment = completeWindowsUserEnvironment(
    { PATH: "C:\\Windows\\system32" },
    { platform: "win32", home: "" },
  );
  assert.deepEqual(environment, { PATH: "C:\\Windows\\system32" });
});

test("other platforms keep their environment exactly as sanitized", () => {
  const environment = completeWindowsUserEnvironment(
    { HOME: "/home/owner", PATH: "/usr/bin" },
    { platform: "darwin", home: "/ignored" },
  );
  assert.deepEqual(environment, { HOME: "/home/owner", PATH: "/usr/bin" });
});

test("the shell environment keeps user profile variables and drops the rest", () => {
  const platform = process.platform;
  const profile = platform === "win32" ? PROFILE : "/home/owner";
  const source: NodeJS.ProcessEnv = {
    [platform === "win32" ? "USERPROFILE" : "HOME"]: profile,
    PATH: platform === "win32" ? "C:\\Windows\\system32" : "/usr/bin",
    SECRET_API_KEY: "provider-key",
    ...(platform === "win32" ? { SYSTEMROOT: "C:\\Windows" } : {}),
  };
  const environment = sanitizeToolEnvironment(source);
  assert.equal(environment.SECRET_API_KEY, undefined);
  assert.equal(
    environment[platform === "win32" ? "USERPROFILE" : "HOME"],
    profile,
  );
  if (platform !== "win32") return;
  for (const name of ["APPDATA", "LOCALAPPDATA", "HOME", "USERPROFILE"]) {
    const value = environment[name];
    assert.equal(typeof value, "string", `${name} must be present`);
    assert.ok(isAbsolute(value!), `${name} must be an absolute path`);
  }
  assert.equal(environment.APPDATA, join(PROFILE, "AppData", "Roaming"));
});

test("a blocked name is not recreated by profile completion", () => {
  if (process.platform !== "win32") return;
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: PROFILE, SYSTEMROOT: "C:\\Windows" },
    ["APPDATA"],
  );
  assert.equal(environment.APPDATA, undefined);
  assert.equal(environment.LOCALAPPDATA, join(PROFILE, "AppData", "Local"));
});
