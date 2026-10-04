/** Local-only, credential-free Chat Completions fixture. No upstream requests. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function startMockModelServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ data: [{ id: "zenx-mock", object: "model" }] }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const request = JSON.parse(body);
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const last = messages.at(-1);
      const user = [...messages].reverse().find((m) => m.role === "user");
      let text =
        typeof user?.content === "string"
          ? user.content
          : JSON.stringify(user?.content ?? "");
      // A Room wakeup includes older context. Its Reason line identifies this send.
      text = text.match(/^Reason: (.*)$/m)?.[1] ?? text;
      if (text.includes("[mock:error]")) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "Intentional mock provider failure" },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const emit = (delta, finish_reason = null) => {
        if (!res.destroyed)
          res.write(
            "data: " +
              JSON.stringify({
                id: "mock-completion",
                object: "chat.completion.chunk",
                model: "zenx-mock",
                choices: [{ index: 0, delta, finish_reason }],
              }) +
              "\n\n",
          );
      };
      emit({ role: "assistant" });
      if (text.includes("[mock:tool]") && last?.role !== "tool") {
        const tool = request.tools?.find((t) => t.function?.name === "shell");
        if (!tool) {
          emit({ content: "[Mock] Shell tool is not available." });
          emit({}, "stop");
        } else {
          emit({
            tool_calls: [
              {
                index: 0,
                id: `mock-${randomUUID()}`,
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({
                    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('mock-tool-ok')"`,
                  }),
                },
              },
            ],
          });
          emit({}, "tool_calls");
        }
      } else {
        const answer =
          last?.role === "tool"
            ? "[Mock] Tool result received: " +
              String(last.content).slice(0, 200)
            : "[Mock] Your message was received. This is a local simulated response, not a real model.";
        const words = text.includes("[mock:slow]")
          ? Array(60).fill("mock-stream ")
          : (answer.match(/.{1,12}/gs) ?? []);
        for (const word of words) {
          if (res.destroyed) break;
          emit({ content: word });
          await delay(text.includes("[mock:slow]") ? 500 : 5);
        }
        emit({}, "stop");
      }
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mock = await startMockModelServer(
    Number(process.env.ZENX_MOCK_PORT ?? 43123),
  );
  console.log(
    `Mock provider: ${mock.url} (local only; any dummy API key; no upstream requests)`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void mock.close().then(() => process.exit(0)));
}
