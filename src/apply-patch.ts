import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelTool } from "./model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolRuntime,
} from "./tool.js";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

interface AddHunk {
  kind: "add";
  path: string;
  content: string;
}

interface DeleteHunk {
  kind: "delete";
  path: string;
}

interface UpdateChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

interface UpdateHunk {
  kind: "update";
  path: string;
  moveTo?: string;
  chunks: UpdateChunk[];
}

type PatchHunk = AddHunk | DeleteHunk | UpdateHunk;

type FileState = { exists: true; content: string } | { exists: false };

type PlannedOperation =
  | {
      kind: "add" | "update";
      displayPath: string;
      path: string;
      expected: FileState;
      content: string;
    }
  | {
      kind: "delete";
      displayPath: string;
      path: string;
      expected: FileState;
    }
  | {
      kind: "move";
      displayPath: string;
      sourcePath: string;
      sourceExpected: FileState;
      destinationPath: string;
      destinationExpected: FileState;
      content: string;
    };

/** Exact single-tool runtime for Codex-style patch text. */
export class ApplyPatchToolRuntime implements ToolRuntime {
  readonly name = "apply_patch";
  readonly specification: ModelTool = {
    name: this.name,
    description:
      "Apply the supported Codex-style patch subset to files relative to the thread working directory.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Patch text delimited by *** Begin Patch and *** End Patch using Add, Update, Move, Delete, @@ exact context, and optional *** End of File markers.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  };

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    if (invocation.name !== this.name) {
      throw new Error(
        `Tool runtime ${this.name} received invocation for ${invocation.name}`,
      );
    }
    const keys = Object.keys(invocation.arguments);
    const patch = invocation.arguments.patch;
    if (
      typeof patch !== "string" ||
      patch.length === 0 ||
      keys.some((key) => key !== "patch")
    ) {
      return {
        output: "apply_patch requires exactly one non-empty string patch",
        exitCode: 1,
      };
    }
    invocation.signal.throwIfAborted();
    try {
      const hunks = parsePatch(patch);
      const operations = await planPatch(
        hunks,
        invocation.cwd,
        invocation.signal,
      );
      return await commitPatch(operations, invocation.signal);
    } catch (error) {
      if (invocation.signal.aborted) throw error;
      return {
        output: `apply_patch failed: ${describeError(error)}`,
        exitCode: 1,
      };
    }
  }
}

function parsePatch(source: string): PatchHunk[] {
  const lines = source.trim().split(/\r?\n/u);
  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw new Error(`The first line of the patch must be '${BEGIN_PATCH}'`);
  }
  if (lines.at(-1)?.trim() !== END_PATCH) {
    throw new Error(`The last line of the patch must be '${END_PATCH}'`);
  }
  const hunks: PatchHunk[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    if (line.startsWith(ADD_FILE)) {
      const filePath = requiredPath(line.slice(ADD_FILE.length), index + 1);
      index += 1;
      const added: string[] = [];
      while (index < lines.length - 1 && !isFileMarker(lines[index]!)) {
        const addedLine = lines[index]!;
        if (!addedLine.startsWith("+")) {
          throw invalidHunk(index + 1, "added file lines must start with '+'");
        }
        added.push(addedLine.slice(1));
        index += 1;
      }
      if (added.length === 0) {
        throw invalidHunk(index + 1, "add file requires at least one line");
      }
      hunks.push({
        kind: "add",
        path: filePath,
        content: `${added.join("\n")}\n`,
      });
      continue;
    }
    if (line.startsWith(DELETE_FILE)) {
      hunks.push({
        kind: "delete",
        path: requiredPath(line.slice(DELETE_FILE.length), index + 1),
      });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_FILE)) {
      const filePath = requiredPath(line.slice(UPDATE_FILE.length), index + 1);
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith(MOVE_TO)) {
        moveTo = requiredPath(lines[index]!.slice(MOVE_TO.length), index + 1);
        index += 1;
      }
      const chunks: UpdateChunk[] = [];
      let chunk: UpdateChunk | undefined;
      const finishChunk = (): void => {
        if (chunk === undefined) return;
        if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
          throw invalidHunk(index + 1, "update section has no lines");
        }
        chunks.push(chunk);
        chunk = undefined;
      };
      while (index < lines.length - 1 && !isFileMarker(lines[index]!)) {
        const updateLine = lines[index]!;
        if (chunk?.endOfFile === true && updateLine.trim().length === 0) {
          index += 1;
          continue;
        }
        if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
          finishChunk();
          chunk = {
            ...(updateLine === "@@" ? {} : { context: updateLine.slice(3) }),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };
          index += 1;
          continue;
        }
        if (updateLine.trim() === END_OF_FILE) {
          if (chunk === undefined) {
            throw invalidHunk(
              index + 1,
              "end-of-file marker has no update section",
            );
          }
          chunk.endOfFile = true;
          index += 1;
          continue;
        }
        const prefix = updateLine[0];
        if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
          throw invalidHunk(
            index + 1,
            `unexpected update line '${updateLine}'`,
          );
        }
        chunk ??= { oldLines: [], newLines: [], endOfFile: false };
        const content = updateLine.slice(1);
        if (prefix !== "+") chunk.oldLines.push(content);
        if (prefix !== "-") chunk.newLines.push(content);
        index += 1;
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === undefined) {
        throw invalidHunk(index + 1, "update file requires a change or move");
      }
      hunks.push({
        kind: "update",
        path: filePath,
        ...(moveTo === undefined ? {} : { moveTo }),
        chunks,
      });
      continue;
    }
    throw invalidHunk(index + 1, `unexpected marker '${line}'`);
  }
  if (hunks.length === 0) throw new Error("No files were modified");
  return hunks;
}

async function planPatch(
  hunks: readonly PatchHunk[],
  cwd: string,
  signal: AbortSignal,
): Promise<PlannedOperation[]> {
  const virtual = new Map<string, FileState>();
  const operations: PlannedOperation[] = [];
  const stateFor = async (filePath: string): Promise<FileState> => {
    const cached = virtual.get(filePath);
    if (cached !== undefined) return cached;
    const state = await readState(filePath);
    virtual.set(filePath, state);
    return state;
  };
  for (const hunk of hunks) {
    signal.throwIfAborted();
    const absolutePath = path.resolve(cwd, hunk.path);
    const current = cloneState(await stateFor(absolutePath));
    if (hunk.kind === "add") {
      operations.push({
        kind: "add",
        displayPath: hunk.path,
        path: absolutePath,
        expected: current,
        content: hunk.content,
      });
      virtual.set(absolutePath, { exists: true, content: hunk.content });
      continue;
    }
    if (!current.exists) throw new Error(`File does not exist: ${hunk.path}`);
    if (hunk.kind === "delete") {
      operations.push({
        kind: "delete",
        displayPath: hunk.path,
        path: absolutePath,
        expected: current,
      });
      virtual.set(absolutePath, { exists: false });
      continue;
    }
    const content = applyUpdate(current.content!, hunk.chunks, hunk.path);
    if (hunk.moveTo === undefined) {
      operations.push({
        kind: "update",
        displayPath: hunk.path,
        path: absolutePath,
        expected: current,
        content,
      });
      virtual.set(absolutePath, { exists: true, content });
      continue;
    }
    const destinationPath = path.resolve(cwd, hunk.moveTo);
    if (destinationPath === absolutePath) {
      throw new Error(`Move destination is the same file: ${hunk.path}`);
    }
    const destination = cloneState(await stateFor(destinationPath));
    operations.push({
      kind: "move",
      displayPath: hunk.moveTo,
      sourcePath: absolutePath,
      sourceExpected: current,
      destinationPath,
      destinationExpected: destination,
      content,
    });
    virtual.set(absolutePath, { exists: false });
    virtual.set(destinationPath, { exists: true, content });
  }
  return operations;
}

function applyUpdate(
  source: string,
  chunks: readonly UpdateChunk[],
  displayPath: string,
): string {
  const normalized = source.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = findSequence(lines, [chunk.context], cursor, false);
      if (contextIndex === -1) {
        throw new Error(
          `Failed to find context '${chunk.context}' in ${displayPath}`,
        );
      }
      cursor = contextIndex + 1;
    }
    const start =
      chunk.oldLines.length === 0
        ? lines.length
        : findSequence(lines, chunk.oldLines, cursor, chunk.endOfFile);
    if (start === -1) {
      throw new Error(
        `Failed to find expected lines in ${displayPath}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    lines.splice(start, chunk.oldLines.length, ...chunk.newLines);
    cursor = start + chunk.newLines.length;
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function findSequence(
  lines: readonly string[],
  sequence: readonly string[],
  start: number,
  endOfFile: boolean,
): number {
  const last = lines.length - sequence.length;
  for (let index = start; index <= last; index += 1) {
    if (endOfFile && index !== last) continue;
    if (sequence.every((line, offset) => lines[index + offset] === line)) {
      return index;
    }
  }
  return -1;
}

async function commitPatch(
  operations: readonly PlannedOperation[],
  signal: AbortSignal,
): Promise<ToolExecutionResult> {
  const changed: string[] = [];
  for (const operation of operations) {
    signal.throwIfAborted();
    try {
      if (operation.kind === "move") {
        await requireUnchanged(operation.sourcePath, operation.sourceExpected);
        await requireUnchanged(
          operation.destinationPath,
          operation.destinationExpected,
        );
        await mkdir(path.dirname(operation.destinationPath), {
          recursive: true,
        });
        signal.throwIfAborted();
        await writeFile(operation.destinationPath, operation.content, "utf8");
        changed.push(`M ${operation.displayPath}`);
        signal.throwIfAborted();
        await unlink(operation.sourcePath);
        continue;
      }
      await requireUnchanged(operation.path, operation.expected);
      if (operation.kind === "delete") {
        await unlink(operation.path);
        changed.push(`D ${operation.displayPath}`);
      } else {
        await mkdir(path.dirname(operation.path), { recursive: true });
        signal.throwIfAborted();
        await writeFile(operation.path, operation.content, "utf8");
        changed.push(
          `${operation.kind === "add" ? "A" : "M"} ${operation.displayPath}`,
        );
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const prefix =
        changed.length === 0
          ? "apply_patch failed"
          : `apply_patch failed after modifying:\n${changed.join("\n")}`;
      return {
        output: `${prefix}\n${describeError(error)}`,
        exitCode: 1,
      };
    }
  }
  return {
    output: `Success. Updated the following files:\n${changed.join("\n")}`,
    exitCode: 0,
  };
}

async function requireUnchanged(
  filePath: string,
  expected: FileState,
): Promise<void> {
  const actual = await readState(filePath);
  if (!sameState(actual, expected)) {
    throw new Error(`File changed since patch preflight: ${filePath}`);
  }
}

async function readState(filePath: string): Promise<FileState> {
  try {
    const bytes = await readFile(filePath);
    return {
      exists: true,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { exists: false };
    if (error instanceof TypeError) {
      throw new Error(`File is not valid UTF-8: ${filePath}`);
    }
    throw error;
  }
}

function sameState(left: FileState, right: FileState): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.content === right.content;
}

function cloneState(state: FileState): FileState {
  return state.exists
    ? { exists: true, content: state.content }
    : { exists: false };
}

function requiredPath(value: string, line: number): string {
  if (value.trim().length === 0) throw invalidHunk(line, "file path is empty");
  return value;
}

function isFileMarker(line: string): boolean {
  return (
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE) ||
    line.trim() === END_PATCH
  );
}

function invalidHunk(line: number, message: string): Error {
  return new Error(`Invalid patch hunk on line ${String(line)}: ${message}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
