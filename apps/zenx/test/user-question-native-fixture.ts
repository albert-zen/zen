import type { ToolEnvironment } from "../../../src/tool.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { NativeConnection } from "../../../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../../../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../../../src/protocol/codex/wire.js";
import type { UserQuestionSpecification } from "../../../src/user-question.js";
import { questionIpcError } from "../src/preload/user-question-ipc.js";
import type { QuestionTransport } from "../src/renderer/src/user-question-state.js";

/** Real Host, journal, native protocol, fake deterministic model; no external services. */
export async function questionNativeFixture(toolEnvironment?: ToolEnvironment) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-question-ui-"));
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    model: "fake",
    provider: { type: "fake" },
    approvalPolicy: "never",
    toolPresentation: "direct",
    ...(toolEnvironment ? { toolEnvironment } : {}),
  });
  const projection = new NativeRecoveryProjection(host);
  const listeners = new Set<(method: string, params: unknown) => void>();
  const replies = new Map<number, JsonRpcMessage>();
  let nextId = 0;
  const connection = new NativeConnection({
    appServer: host,
    projection,
    send(message) {
      if ("id" in message && typeof message.id === "number")
        replies.set(message.id, message);
      else if ("method" in message)
        for (const listener of listeners)
          listener(message.method, message.params);
    },
  });
  const request = async (
    method: string,
    params?: unknown,
  ): Promise<unknown> => {
    const id = ++nextId;
    await connection.receive({ id, method, params });
    const reply = replies.get(id);
    replies.delete(id);
    if (!reply || !("id" in reply)) throw new Error("Missing native reply");
    if ("error" in reply) {
      const error = Object.assign(new Error(reply.error.message), {
        data: reply.error.data,
      });
      if (method.startsWith("zen/thread/questions/"))
        return structuredClone(questionIpcError(error));
      throw error;
    }
    if (!("result" in reply)) throw new Error("Missing native result");
    return structuredClone(reply.result);
  };
  await request("zen/initialize", {});
  return {
    host,
    directory,
    request,
    transport: {
      list: (params) => request("zen/thread/questions/list", params),
      read: (params) => request("zen/thread/questions/read", params),
      respond: (params) => request("zen/thread/questions/respond", params),
    } as QuestionTransport,
    onNotification(listener: (method: string, params: unknown) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async publish(
      threadId: string,
      specification: UserQuestionSpecification = {
        questions: [
          {
            id: "scope",
            prompt: "Which scope should we use?",
            options: [
              {
                id: "small",
                label: "Small",
                description: "Only the selected module",
              },
              {
                id: "large",
                label: "Large",
                description: "The whole synthetic project",
              },
            ],
          },
        ],
        answerTemplate: "Scope: {{scope}}",
      },
    ) {
      await (
        await host.startTurn(
          threadId,
          `!tool ask_user_question ${JSON.stringify(specification)}`,
        )
      ).done;
      return (await host.listUserQuestions(threadId)).questions.at(-1)!;
    },
    async close() {
      connection.close();
      projection.close();
      await host.closeHostResources();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
