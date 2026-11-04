import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    fileURLToPath(new URL("./main.cjs", import.meta.url)),
    path.resolve(process.argv[2] || "webview-experiment-evidence"),
  ],
  { env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
