/** Actual isolated Electron App; synthetic data never leaves its private profile. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { seedInformationLayoutQuestion } from "./seed-information-layout-acceptance.mjs";
import { DomainThreadJournal } from "../../../dist/src/domain-journal.js";
import { FileTraceStore } from "../../../dist/src/trace.js";
import { JsonlThreadMetadataStore } from "../../../dist/src/thread-metadata.js";
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(["win32", "darwin"].includes(process.platform));
const directory = path.resolve(process.argv[2]);
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  execFileSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  "",
  "Capture must use an unchanged production checkout",
);
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "zenx-owned-information-"),
);
const profile = path.join(temporary, "profile"),
  data = path.join(temporary, "zen-data"),
  home = path.join(temporary, "home"),
  workspace = path.join(temporary, "workspace");
for (const p of [profile, data, home, workspace, path.join(home, "Documents")])
  await mkdir(p, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(workspace, "fixture.txt"),
  "Synthetic workspace resource. No user data.\n",
);
await writeFile(
  path.join(profile, "host-profile.json"),
  JSON.stringify({
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        type: "fake",
        displayName: "Synthetic local only",
        providerProfileId: "fake",
        models: [
          {
            id: "fake",
            displayName: "fake",
            description: "Offline information board acceptance",
            hidden: false,
            source: "manual",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            contextWindow: 1000000,
          },
        ],
      },
    ],
    defaultModel: { providerProfileId: "fake", modelId: "fake" },
    titleModel: { providerProfileId: "fake", modelId: "fake" },
    workspace,
    workspaces: [workspace],
    lastUsedWorkspace: workspace,
    approvalPolicy: "never",
  }),
);
const trace = new FileTraceStore(path.join(data, "trace")),
  metadata = new JsonlThreadMetadataStore(
    path.join(data, "thread-metadata.jsonl"),
  );
const journal = new DomainThreadJournal({
  directory: path.join(data, "threads"),
  trace,
  metadata,
});
const selection = {
  providerProfileId: "fake",
  modelId: "fake",
  reasoningEffort: "medium",
};
try {
  for (const [threadId, title, parentThreadId] of [
    ["information-main", "Synthetic layout review", null],
    ["information-other", "Synthetic second conversation", null],
    ["information-child", "Review responsive layout", "information-main"],
  ]) {
    const turnId = threadId + "-turn",
      createdAt = "2026-11-01T12:00:00.000Z";
    await journal.create([
      {
        id: threadId + "-metadata",
        threadId,
        createdAt,
        type: "thread_metadata",
        cwd: workspace,
        ...selection,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        ...(parentThreadId ? { parentThreadId } : {}),
      },
      {
        id: turnId + "-started",
        threadId,
        turnId,
        createdAt,
        type: "turn_started",
        selection,
      },
      {
        id: turnId + "-user",
        threadId,
        turnId,
        createdAt,
        type: "user_message",
        content: [
          {
            type: "text",
            text: "Review the conversation layout without covering the chat.",
          },
        ],
        receiptTimezone: { timeZone: "UTC", source: "client" },
      },
      {
        id: turnId + "-answer",
        threadId,
        turnId,
        createdAt,
        type: "agent_message",
        text: "The information card should sit beside this conversation when space permits. Opening the workspace closes it; reopening in a narrow allocation uses a popover.\n\nThe main conversation tab keeps this transcript and its unsent composer draft intact. All content in this acceptance run is synthetic.",
      },
      {
        id: turnId + "-completed",
        threadId,
        turnId,
        createdAt,
        type: "turn_completed",
        status: "completed",
      },
    ]);
    await metadata.setName(threadId, title);
  }
} finally {
  await journal.close();
  await trace.flush();
}
const questionFixture = await seedInformationLayoutQuestion({
  data,
  workspace,
});
await writeFile(
  path.join(temporary, "information-fixture.json"),
  JSON.stringify(questionFixture),
);
const hashes = {};
for (const file of [
  ...(await readdir(path.join(root, "out/renderer"), { recursive: true }))
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => "out/renderer/" + f),
  ...(await readdir(path.join(root, "out/main"), { recursive: true }))
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file))
    .map((file) => "out/main/" + file),
  "out/preload/index.cjs",
  "src/renderer/src/App.tsx",
  "src/renderer/src/plugin-information-host.tsx",
  "src/renderer/src/ConversationInformationCards.tsx",
  "src/renderer/src/EditableInformationPanel.tsx",
  "src/renderer/src/RoomQuestionCards.tsx",
  "src/renderer/src/room-question-state.ts",
  "src/renderer/src/room-conversations.tsx",
  "src/main/app-server-host.ts",
  "src/main/native-room-question-service.ts",
  "src/main/room-question-publisher.ts",
  "src/native-room-questions.ts",
  "src/room-questions.ts",
  "src/main/native-information-service.ts",
  "src/main/native-information-document.ts",
  "src/native-information.ts",
  "src/information-layout.ts",
  "src/renderer/src/board-ui.tsx",
  "src/renderer/src/board-ui-state.ts",
  "scripts/seed-information-layout-acceptance.mjs",
  "scripts/capture-information-board.cjs",
  "scripts/launch-information-board-acceptance.mjs",
  "../../src/app-server.ts",
  "../../src/user-question-tool.ts",
  "../../dist/src/app-server.js",
  "../../dist/src/user-question-tool.js",
  "../../dist/apps/cli/src/host.js",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(directory, "source.json"),
  JSON.stringify(
    {
      sourceCommit,
      platform: process.platform,
      hashes,
      synthetic: true,
      scope:
        "Full production Electron App, preload, child Host, native input, production DomainThreadJournal and Room journal. Private fake provider only; default-on Thread question genuinely published by a seed Host and retained through shutdown before Desktop starts; independent Room/PAW questions published through real Host model calls, with same-journal Asking and explicit model snapshot withdrawal. Board documents authored through actual runtime model tools. No injected UI, no user data, no user device.",
    },
    null,
    2,
  ),
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(HOME|USERPROFILE|USER_HOME|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_CACHE_HOME)$/i.test(
        key,
      ) &&
      !/OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|AZURE|CODEX|AUTH|TOKEN|SECRET|PASSWORD|ZENX_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|ELECTRON_EXTRA_LAUNCH_ARGS|NODE_OPTIONS/i.test(
        key,
      ),
  ),
);
Object.assign(environment, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  ZENX_DATA_DIR: data,
  GITHUB_ACTIONS: "true",
});
if (process.platform === "win32") {
  Object.assign(environment, {
    USERPROFILE: home,
    USER_HOME: home,
    HOMEDRIVE: path.parse(home).root.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  });
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
}
const child = spawn(
  electron,
  [
    path.join(root, "scripts/capture-information-board.cjs"),
    directory,
    temporary,
    `--user-data-dir=${profile}`,
  ],
  {
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform === "darwin",
  },
);
async function waitOwnedWindowsTree(child, timeoutMs) {
  let closed = false;
  const terminal = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  let timer;
  try {
    return await Promise.race([
      terminal,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned Electron diagnostic timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (
      !closed &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      // PID is from our still-live ChildProcess, never process-name-wide termination.
      execFileSync(
        path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT,
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { timeout: 5000, windowsHide: true, stdio: "ignore" },
      );
      let closeTimer;
      try {
        await Promise.race([
          terminal,
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error("Owned tree exit unconfirmed")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
// macOS child owns a new POSIX process group (detached:true above).
// Never target another process name/session or weaken Chromium's sandbox.
async function waitOwnedPosixGroup(child, timeoutMs) {
  const terminal = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const within = async (ms) => {
    let deadline;
    try {
      return await Promise.race([
        terminal,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Owned POSIX group exit timeout")),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const signalGroup = (signal) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  try {
    return await within(timeoutMs);
  } catch (error) {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw error;
    signalGroup("SIGTERM");
    try {
      await within(5000);
    } catch {
      signalGroup("SIGKILL");
      await within(5000);
    }
    // Parent close alone does not prove the group's remaining descendants exited.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
        signalGroup("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    throw error;
  }
}
let validated = false,
  observedClose;
child.once("close", (code, signal) => {
  observedClose = { code, signal };
});
try {
  const code = await (
    process.platform === "win32" ? waitOwnedWindowsTree : waitOwnedPosixGroup
  )(child, 240000);
  assert.equal(code, 0, "Owned production App acceptance must pass");
  const result = JSON.parse(
    await readFile(path.join(directory, "acceptance.json"), "utf8"),
  );
  assert.equal(result.ok, true);
  assert.ok(result.cases.length >= 8);
  validated = true;
} finally {
  await writeFile(
    path.join(directory, "lifecycle.json"),
    JSON.stringify(
      {
        observedClose,
        validated,
        privateFixture: validated
          ? "removed after confirmed normal Host shutdown"
          : "retained privately, not uploaded",
      },
      null,
      2,
    ),
  );
  if (validated) await rm(temporary, { recursive: true, force: true });
}
