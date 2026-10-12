import assert from "node:assert/strict";
import test from "node:test";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../src/tool.js";

function call(
  name: string,
  args: Record<string, unknown>,
  threadId = "shared",
): ToolInvocation {
  return {
    name,
    arguments: args,
    threadId,
    cwd: process.cwd(),
    callId: name,
    signal: new AbortController().signal,
  };
}
test("Shell UI observes the exact Agent task without consuming wait output; ownership is checked", async () => {
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 20 },
  });
  try {
    const result = await tools.execute(
      tools.prepare(
        call("shell", {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('shared');setTimeout(()=>{},30000)"`,
        }),
      ),
    );
    const taskId = (result.structuredContent as { task_id: string }).task_id;
    const summaries = tools.taskManager.listShellSessions("shared");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.taskId, taskId);
    assert.equal(summaries[0]!.origin, "agent");
    assert.deepEqual(tools.taskManager.listShellSessions("another"), []);
    assert.throws(
      () => tools.taskManager.readShellSession("another", taskId),
      /not found/,
    );
    const first = tools.taskManager.readShellSession("shared", taskId);
    assert.equal(first.session.inputAvailable, false);
    assert.throws(
      () =>
        tools.taskManager.writeShellSession(
          "shared",
          taskId,
          "echo forbidden\r",
        ),
      /human|input/i,
    );
    await tools.taskManager.stopShellSession("shared", taskId);
    const stopped = await tools.waitRuntime.execute(
      call("wait", { task_id: taskId, yield_time_ms: 1000 }),
    );
    assert.equal(
      (stopped.structuredContent as { status: string }).status,
      "cancelled",
    );
    assert.equal(
      tools.taskManager.readShellSession("shared", taskId).session.status,
      "cancelled",
    );
    await assert.rejects(
      () => tools.waitRuntime.execute(call("wait", { task_id: taskId })),
      /not found/,
    );
  } finally {
    await tools.close();
  }
});

test("retained Shell scrollback has independent bounded cursors and cannot revive execution", async () => {
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 1000, maxTasks: 2 },
  });
  try {
    await tools.execute(
      tools.prepare(
        call("shell", {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(80000) + 'END')"`,
        }),
      ),
    );
    const summary = tools.taskManager.listShellSessions("shared")[0]!;
    assert(summary.retained);
    const first = tools.taskManager.readShellSession("shared", summary.taskId);
    assert(first.truncated);
    assert.equal(first.output.length, 32768);
    const next = tools.taskManager.readShellSession(
      "shared",
      summary.taskId,
      first.cursor,
    );
    assert.equal(next.truncated, false);
    assert.match(next.output, /END$/);
    assert.equal(first.output.length + next.output.length, 65536);
    assert.deepEqual(
      tools.taskManager.readShellSession("shared", summary.taskId),
      first,
    );
    assert.throws(
      () =>
        tools.taskManager.readShellSession(
          "shared",
          summary.taskId,
          next.cursor + 1,
        ),
      /ahead/,
    );
    for (let n = 0; n < 3; n++)
      await tools.execute(
        tools.prepare(
          call("shell", {
            command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('${n}')"`,
          }),
        ),
      );
    assert.equal(tools.taskManager.listShellSessions("shared").length, 2);
    assert.throws(
      () => tools.taskManager.readShellSession("shared", summary.taskId),
      /not found/,
    );
    await tools.close();
    assert.deepEqual(tools.taskManager.listShellSessions("shared"), []);
  } finally {
    await tools.close();
  }
});

test("Agent session list and read remain available with no free execution capacity", async () => {
  const tools = new ToolEnvironment({
    shellSessions: true,
    runtimes: [new ShellToolRuntime()],
    taskOptions: { maxRunningTasks: 1, yieldTimeMs: 1 },
  });
  try {
    const running = await tools.execute(
      tools.prepare(
        call("shell", {
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},30000)"`,
        }),
      ),
    );
    const taskId = (running.structuredContent as { task_id: string }).task_id;
    const list = await tools.execute(tools.prepare(call("shell_sessions", {})));
    assert.equal(JSON.parse(list.output)[0].taskId, taskId);
    const read = await tools.execute(
      tools.prepare(call("shell_sessions", { task_id: taskId })),
    );
    assert.equal(JSON.parse(read.output).session.taskId, taskId);
    assert.equal(tools.taskManager.listShellSessions("shared").length, 1);
  } finally {
    await tools.close();
  }
});
