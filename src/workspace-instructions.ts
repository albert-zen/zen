import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  MAX_WORKSPACE_INSTRUCTION_BYTES,
  type WorkspaceInstructionFile,
} from "./item.js";

const run = promisify(execFile);

/** Read only the repository root's AGENTS.md for a new Thread's first message. */
export async function loadWorkspaceInstructions(
  cwd: string,
): Promise<WorkspaceInstructionFile[]> {
  const actualCwd = await realpath(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  let repository: string;
  try {
    const result = await run(
      "git",
      ["-C", actualCwd, "rev-parse", "--show-toplevel"],
      {
        env,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    repository = result.stdout.replace(/\r?\n$/u, "");
  } catch (error) {
    const failure = error as { stderr?: string };
    if (failure.stderr?.includes("not a git repository")) return [];
    throw new Error(
      `Cannot locate repository for workspace instructions at ${actualCwd}: ${String(error)}`,
    );
  }
  const filename = path.join(repository, "AGENTS.md");
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) throw new Error("expected a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Cannot read workspace instructions ${filename}: ${String(error)}`,
    );
  }
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(MAX_WORKSPACE_INSTRUCTION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_WORKSPACE_INSTRUCTION_BYTES) {
      throw new Error(
        `AGENTS.md exceeds the ${MAX_WORKSPACE_INSTRUCTION_BYTES}-byte workspace instruction budget`,
      );
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    return [{ path: filename, text }];
  } catch (error) {
    throw new Error(
      `Cannot read workspace instructions ${filename}: ${String(error)}`,
    );
  } finally {
    await handle.close();
  }
}
