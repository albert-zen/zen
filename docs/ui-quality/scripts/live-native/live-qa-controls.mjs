// QA-only runtime fixture. No production files or persisted facts are rewritten.
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const applied = Symbol.for("zenx.uiQuality.liveQa.v1");
const inputText = (input) =>
  typeof input === "string"
    ? input
    : Array.isArray(input)
      ? input
          .filter((p) => p?.type === "text")
          .map((p) => p.text)
          .join("\n")
      : "";
const latestText = (request) => {
  const message = request.messages.findLast((m) => m.role === "user");
  return inputText(message?.content ?? message?.text ?? "");
};
const commandOf = (text) =>
  text.match(/\bQA_(?:STREAM|HOLD|FAIL|ADMIT|REJECT)\b/)?.[0];

export function installLiveQa({
  FakeModel,
  ZenAppServer,
  AppServerError,
  receiptPath,
  intervalMs = 1000,
  admissionMs = 15000,
  failureMs = 3000,
  chunks = 600,
}) {
  if (FakeModel.prototype[applied])
    throw new Error("Live QA fixture installed twice");
  FakeModel.prototype[applied] = true;
  const record = async (event, detail = {}) => {
    if (receiptPath)
      await appendFile(
        receiptPath,
        JSON.stringify({ at: new Date().toISOString(), event, ...detail }) +
          "\n",
      );
  };
  FakeModel.prototype.stream = async function* (request) {
    const text = latestText(request);
    request.signal.throwIfAborted();
    // Do not delegate to production FakeModel: it interprets !shell/!tool.
    // Inspect every joined text part before command matching so a second part
    // cannot smuggle a tool command behind a valid QA command.
    if (/^\s*!(?:shell|tool)(?:\s|$)/mu.test(text)) {
      throw Object.assign(
        new Error(
          "Local QA rejects !shell and !tool input; use plain text or a documented QA command.",
        ),
        { modelRecoveryBlocked: true },
      );
    }
    const command = commandOf(text);
    if (!["QA_STREAM", "QA_HOLD", "QA_FAIL"].includes(command)) {
      // Ordinary text is useful for queue/steer and edited-send recovery.
      // This local echo never interprets commands or produces tool_call events.
      yield { type: "text_delta", delta: `Echo: ${text}` };
      yield {
        type: "usage",
        inputTokens: text.length,
        outputTokens: text.length + 6,
      };
      return;
    }
    const identity = { command, threadId: request.sessionId ?? null };
    await record("model_started", identity);
    let emitted = 0;
    try {
      yield {
        type: "text_delta",
        delta: `## Controlled local ${command === "QA_STREAM" ? "stream" : command === "QA_FAIL" ? "failure" : "hold"}\n\nSynthetic local QA adapter. This response emits text only; the fixture is not an OS sandbox.\n\n`,
      };
      if (command === "QA_FAIL") {
        await sleep(failureMs, undefined, { signal: request.signal });
        throw Object.assign(
          new Error(
            "Synthetic QA provider failure after partial output. No external request was made.",
          ),
          { modelRecoveryBlocked: true },
        );
      }
      if (command === "QA_HOLD") {
        await sleep(intervalMs * chunks, undefined, { signal: request.signal });
        yield {
          type: "text_delta",
          delta: "The controlled hold reached its time limit.\n",
        };
      } else {
        for (let i = 1; i <= chunks; i++) {
          await sleep(intervalMs, undefined, { signal: request.signal });
          request.signal.throwIfAborted();
          yield {
            type: "text_delta",
            delta: `### Live checkpoint ${String(i).padStart(3, "0")}\n\nThis paragraph arrived while the native thread was running. Scroll upward to hold your reading position, then return to the bottom to resume following new output.\n\n`,
          };
          emitted++;
          if (i === 1 || i % 10 === 0)
            await record("model_progress", { ...identity, emitted });
        }
      }
      yield {
        type: "usage",
        inputTokens: 100,
        outputTokens: emitted * 40 + 50,
      };
      await record("model_completed", { ...identity, emitted });
    } catch (error) {
      await record(
        request.signal.aborted ? "model_interrupted" : "model_failed",
        { ...identity, emitted, message: error.message },
      );
      throw error;
    }
  };

  // Admission delays/rejections are intentionally *before* the real public call.
  // They do not invent accepted input or durable state. Nested public calls are
  // guarded so one request is delayed only once.
  const guarded = new WeakMap();
  for (const [method, inputIndex] of [
    ["sendMessage", 1],
    ["startTurn", 1],
    ["queueMessage", 1],
    ["stageSteerMessage", 2],
    ["replaceTurn", 2],
  ]) {
    const original = ZenAppServer.prototype[method];
    if (typeof original !== "function")
      throw Error(`Missing public API: ${method}`);
    ZenAppServer.prototype[method] = async function (...args) {
      const command = commandOf(inputText(args[inputIndex]));
      const key = `${args[0]}:${inputText(args[inputIndex])}`;
      let active = guarded.get(this);
      if (!active) guarded.set(this, (active = new Set()));
      if (!["QA_ADMIT", "QA_REJECT"].includes(command) || active.has(key))
        return original.apply(this, args);
      active.add(key);
      try {
        await record("admission_waiting", {
          command,
          method,
          threadId: args[0],
        });
        await sleep(command === "QA_ADMIT" ? admissionMs : failureMs);
        if (command === "QA_REJECT") {
          await record("admission_rejected", {
            command,
            method,
            threadId: args[0],
            committed: false,
          });
          throw new AppServerError(
            "invalid_input",
            "Synthetic QA admission rejection. Input was not committed. Edit the draft and remove QA_REJECT before resending.",
          );
        }
        const result = await original.apply(this, args);
        await record("admission_released", {
          command,
          method,
          threadId: args[0],
        });
        return result;
      } finally {
        active.delete(key);
      }
    };
  }
  return { record };
}
