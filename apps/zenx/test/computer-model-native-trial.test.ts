import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executable = process.env.ZENX_STRICT_UIA_EXE;
const runner = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "computer-model-live-runner.ts",
);

test(
  "real strict UIA model trial reads native value proof and two app-visible apply effects",
  { skip: process.platform !== "win32" || !executable, timeout: 120_000 },
  async () => {
    await access(executable!);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", runner, "--winapp", executable!],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(-8192);
    });
    const inbox: Array<Record<string, any>> = [];
    const waiters: Array<(value: Record<string, any>) => void> = [];
    const closed = new Promise<number | null>((resolve) =>
      child.once("close", (code) => {
        for (const waiter of waiters.splice(0))
          waiter({ fatal: `Runner exited ${code}: ${stderr}` });
        resolve(code);
      }),
    );
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        const parsed = JSON.parse(line) as Record<string, any>;
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else inbox.push(parsed);
      },
    );
    const next = () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift() as Record<string, any>)
        : new Promise<Record<string, any>>((resolve) => waiters.push(resolve));
    const call = async (tool: string, args: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ tool, args })}\n`);
      const reply = await next();
      assert.equal(reply.tool, tool, `${JSON.stringify(reply)} ${stderr}`);
      assert.equal(reply.error, undefined);
      return reply.result as Record<string, any>;
    };
    const control = (result: Record<string, any>, title: string) => {
      const matches = (result.controls as Array<Record<string, any>>).filter(
        (item) => item.title === title,
      );
      assert.equal(matches.length, 1, `${title} must be one native control`);
      return matches[0]!;
    };
    try {
      const ready = await next();
      assert.equal(ready.ready, true, JSON.stringify(ready));
      const window = ready.windows.windows[0];
      assert.match(window.ref, /^r[1-9][0-9]*$/u);
      const initial = await call("computer_inspect", { target: window.ref });
      let editor = control(initial, "ZenX packaged editor");
      assert.deepEqual(editor.actions, ["set_value"]);
      control(initial, "Apply draft");

      for (const [index, value] of [
        "中文输入验证 🙂",
        "第二次修改",
      ].entries()) {
        const set = await call("computer_set_value", {
          control: editor.ref,
          value,
        });
        assert.equal(set.actionCompleted, true);
        assert.equal(set.dispatch, "completed");
        assert.equal(set.applicationEffect, "unverified");
        assert.deepEqual(set.valueReadback, {
          matchesRequested: true,
          source: "native_value_pattern",
        });
        assert.equal(control(set.after, `Draft: ${value}`).actions.length, 0);
        const apply = control(set.after, "Apply draft");
        const pressed = await call("computer_press", { control: apply.ref });
        assert.equal(pressed.actionCompleted, true);
        assert.equal(pressed.dispatch, "completed");
        assert.equal(
          control(pressed.after, `Applied ${index + 1}: ${value}`).actions
            .length,
          0,
        );
        const independent = await call("computer_inspect", {
          target: window.ref,
          query: `Applied ${index + 1}: ${value}`,
        });
        assert.equal(independent.focus.matched, 1);
        control(independent, `Applied ${index + 1}: ${value}`);
        if (index === 0) {
          const fresh = await call("computer_inspect", {
            target: window.ref,
          });
          editor = control(fresh, "ZenX packaged editor");
        }
      }
      child.stdin.write('{"tool":"exit"}\n');
      // The explicit exit request must work while an interactive caller keeps stdin open.
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error("Runner did not close after exit request")),
            10_000,
          );
        }),
      ]).finally(() => clearTimeout(exitTimer));
      assert.equal(code, 0, stderr);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  },
);
