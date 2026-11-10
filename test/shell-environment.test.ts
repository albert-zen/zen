import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeToolEnvironment,
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../src/tool.js";

const PROFILE = "C:\\Users\\owner";
const WINDOWS = { platform: "win32" as const, home: () => "" };

test("Windows shells retain the profile variables required by gh and conda", () => {
  const environment = sanitizeToolEnvironment(
    {
      USERPROFILE: PROFILE,
      APPDATA: "D:\\Roaming",
      LOCALAPPDATA: "D:\\Local",
      SECRET_API_KEY: "provider-key",
    },
    [],
    { platform: "win32", home: () => "" },
  );
  assert.equal(environment.APPDATA, "D:\\Roaming");
  assert.equal(environment.LOCALAPPDATA, "D:\\Local");
  assert.equal(environment.USERPROFILE, PROFILE);
  assert.equal(environment.SECRET_API_KEY, undefined);
});

test("GUI-launched Windows shells complete missing profile variables", () => {
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: PROFILE, SYSTEMROOT: "C:\\Windows" },
    [],
    WINDOWS,
  );
  assert.deepEqual(environment, {
    USERPROFILE: PROFILE,
    SYSTEMROOT: "C:\\Windows",
    HOME: PROFILE,
    APPDATA: `${PROFILE}\\AppData\\Roaming`,
    LOCALAPPDATA: `${PROFILE}\\AppData\\Local`,
    TEMP: `${PROFILE}\\AppData\\Local\\Temp`,
    TMP: `${PROFILE}\\AppData\\Local\\Temp`,
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\owner",
    SYSTEMDRIVE: "C:",
  });
});

test("inherited profile values win, including redirected AppData and temp", () => {
  const source = {
    USERPROFILE: PROFILE,
    HOME: "D:\\home",
    APPDATA: "\\\\server\\profiles\\roaming",
    LOCALAPPDATA: "D:\\local",
    TEMP: "D:\\temp",
    TMP: "E:\\tmp",
    HOMEDRIVE: "H:",
    HOMEPATH: "\\owner",
  };
  const environment = sanitizeToolEnvironment(source, [], WINDOWS);
  for (const [name, value] of Object.entries(source))
    assert.equal(environment[name], value);
  assert.deepEqual(source.USERPROFILE, PROFILE);
});

test("missing temp derives from inherited LOCALAPPDATA, not profile AppData", () => {
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: PROFILE, LOCALAPPDATA: "D:\\local" },
    [],
    WINDOWS,
  );
  assert.equal(environment.TEMP, "D:\\local\\Temp");
  assert.equal(environment.TMP, "D:\\local\\Temp");
});

test("profile fallback uses drive/path then the OS home, without mutating source", () => {
  const source = { HOMEDRIVE: "D:", HOMEPATH: "\\profiles\\owner" };
  const environment = sanitizeToolEnvironment(source, [], {
    ...WINDOWS,
    home: () => {
      throw new Error("must not read OS home");
    },
  });
  assert.equal(environment.USERPROFILE, "D:\\profiles\\owner");
  assert.equal(environment.HOME, "D:\\profiles\\owner");
  assert.deepEqual(source, { HOMEDRIVE: "D:", HOMEPATH: "\\profiles\\owner" });
  const fallback = sanitizeToolEnvironment({}, [], {
    ...WINDOWS,
    home: () => PROFILE,
  });
  assert.equal(fallback.USERPROFILE, PROFILE);
  assert.equal(fallback.APPDATA, `${PROFILE}\\AppData\\Roaming`);
});

test("UNC profiles are supported without inventing a drive letter", () => {
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: "\\\\server\\users\\owner" },
    [],
    WINDOWS,
  );
  assert.equal(
    environment.APPDATA,
    "\\\\server\\users\\owner\\AppData\\Roaming",
  );
  assert.equal(environment.HOMEDRIVE, undefined);
  assert.equal(environment.HOMEPATH, undefined);
});

test("unavailable or relative profiles do not produce fictional directories", () => {
  for (const home of [
    () => "",
    () => "relative",
    () => "C:relative",
    () => "\\profile-without-drive",
    () => {
      throw new Error("unavailable");
    },
  ]) {
    assert.deepEqual(
      sanitizeToolEnvironment({ PATH: "C:\\Windows" }, [], {
        ...WINDOWS,
        home,
      }),
      { PATH: "C:\\Windows" },
    );
  }
});

test("Windows case aliases collapse and nonempty inherited values survive", () => {
  const environment = sanitizeToolEnvironment(
    {
      userprofile: PROFILE,
      APPDATA: "",
      AppData: "D:\\roaming",
      Path: "C:\\bin",
      lc_all: "C.UTF-8",
      Secret_Api_Key: "provider-key",
    },
    [],
    WINDOWS,
  );
  assert.equal(environment.APPDATA, "D:\\roaming");
  assert.equal(environment.USERPROFILE, PROFILE);
  assert.equal(environment.PATH, "C:\\bin");
  assert.equal(environment.LC_ALL, "C.UTF-8");
  assert.equal(environment.Secret_Api_Key, undefined);
  assert.equal(environment.SECRET_API_KEY, undefined);
  assert.ok(
    Object.keys(environment).every((name) => name === name.toUpperCase()),
  );
});

test("blocked Windows names stay absent after completion and cannot supply defaults", () => {
  const environment = sanitizeToolEnvironment(
    {
      USERPROFILE: "D:\\blocked",
      HOME: "D:\\blocked-home",
      AppData: "D:\\blocked-roaming",
      LocalAppData: "D:\\blocked-local",
      SECRET_API_KEY: "provider-key",
    },
    ["userprofile", "home", "appDATA", "LOCALAPPDATA", "tmp"],
    {
      ...WINDOWS,
      home: () => PROFILE,
    },
  );
  for (const name of [
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "TMP",
    "SECRET_API_KEY",
  ])
    assert.equal(environment[name], undefined);
  assert.equal(environment.TEMP, undefined);
});

test("blocked USERPROFILE cannot be reread through the OS-home fallback", () => {
  let homeReads = 0;
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: "C:\\private-credential" },
    ["userprofile"],
    {
      platform: "win32",
      home: () => {
        homeReads++;
        return "C:\\private-credential";
      },
    },
  );
  assert.equal(homeReads, 0);
  assert.deepEqual(environment, {});
});

test("blocking a derived name does not prevent other safe profile defaults", () => {
  const environment = sanitizeToolEnvironment(
    { USERPROFILE: PROFILE },
    ["appdata", "tmp"],
    WINDOWS,
  );
  assert.equal(environment.APPDATA, undefined);
  assert.equal(environment.TMP, undefined);
  assert.equal(environment.TEMP, `${PROFILE}\\AppData\\Local\\Temp`);
  assert.equal(environment.HOME, PROFILE);
});

test("non-Windows filtering remains case-sensitive with no Windows completion", () => {
  const environment = sanitizeToolEnvironment(
    {
      HOME: "/home/owner",
      home: "/wrong",
      PATH: "/bin",
      Path: "/wrong",
      LC_ALL: "C.UTF-8",
      APPDATA: "not-a-posix-shell-variable",
      SECRET: "secret",
    },
    ["home"],
    {
      platform: "linux",
      home: () => {
        throw new Error("must not read home");
      },
    },
  );
  assert.deepEqual(environment, {
    HOME: "/home/owner",
    PATH: "/bin",
    LC_ALL: "C.UTF-8",
  });
});

test("command shells and integrated terminals receive the same sanitized snapshot", async () => {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === "win32"
      ? {
          USERPROFILE: PROFILE,
          APPDATA: "D:\\roaming",
          LOCALAPPDATA: "D:\\local",
        }
      : { HOME: "/home/owner" }),
    SECRET_API_KEY: "provider-key",
    USER: "blocked-user",
  };
  const expected = sanitizeToolEnvironment(source, ["USER"]);
  let terminalEnvironment: NodeJS.ProcessEnv | undefined;
  const shell = new ShellToolRuntime({
    environment: source,
    blockedEnvironmentVariables: ["USER"],
    pty: {
      async spawn({ env }) {
        terminalEnvironment = env;
        return {
          write() {},
          resize() {},
          kill() {},
          onData() {
            return { dispose() {} };
          },
          onExit(listener) {
            queueMicrotask(() => listener({ exitCode: 0 }));
            return { dispose() {} };
          },
        };
      },
    },
  });
  source.HOME = "changed-after-construction";
  const invoke = (arguments_: Record<string, unknown>): ToolInvocation => ({
    name: "shell",
    arguments: arguments_,
    callId: "environment-check",
    threadId: "environment-check",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sandbox: "danger-full-access",
  });
  const names = [
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "USER",
    "SECRET_API_KEY",
  ];
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(k=>[k,process.env[k]]))))`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const result = await shell.execute(invoke({ command }));
  assert.equal(result.exitCode, 0);
  const expectedSelected = JSON.parse(
    JSON.stringify(
      Object.fromEntries(names.map((name) => [name, expected[name]])),
    ),
  );
  assert.deepEqual(JSON.parse(result.output), expectedSelected);
  const tools = new ToolEnvironment({
    runtimes: [shell],
    taskOptions: { yieldTimeMs: 1000 },
  });
  try {
    await tools.execute(
      tools.prepare({ ...invoke({}), userTerminal: { cols: 80, rows: 24 } }),
    );
    assert.deepEqual(terminalEnvironment, expected);
    assert.ok(Object.isFrozen(terminalEnvironment));
  } finally {
    await tools.close();
  }
});
