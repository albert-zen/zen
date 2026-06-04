import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  AppServer,
  serveAppServerHttpTransport
} from "../../dist/index.js";

function sequence(prefix) {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}

const model = {
  async *generate(context) {
    const hasToolResult = context.parts.some((part) => part.type === "toolResult");

    if (hasToolResult) {
      yield {
        type: "message.completed",
        content: "Transport smoke completed with shell output."
      };
      return;
    }

    yield { type: "text.delta", text: "Preparing shell command..." };
    yield {
      type: "message.completed",
      content: "I will run the smoke shell command.",
      toolCalls: [
        {
          id: "smoke-shell-1",
          name: "shell",
          input: { command: "Write-Output web-smoke" }
        }
      ]
    };
  }
};

const toolRuntime = {
  async *execute() {
    yield {
      type: "output.delta",
      delta: { stream: "stdout", chunk: "web-smoke\n" }
    };
    yield {
      type: "result.completed",
      content: { exitCode: 0, stdout: "web-smoke\n", stderr: "" }
    };
  }
};

const appServer = new AppServer({
  threadManagerOptions: {
    generateThreadId: sequence("smoke-thread"),
    generateRunId: sequence("smoke-run"),
    generateTurnId: sequence("smoke-turn"),
    generateItemId: sequence("smoke-item"),
    clock: () => Date.now(),
    runtimeFactory: () => ({ model, toolRuntime })
  }
});

const transport = await serveAppServerHttpTransport({
  appServer,
  host: "127.0.0.1",
  port: 0
});
const root = resolve(".");
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

const staticServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname =
      url.pathname === "/" ? "/web/index.html" : decodeURIComponent(url.pathname);
    const filePath = resolve(root, `.${pathname.replaceAll("/", sep)}`);

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
});

await new Promise((resolveListen, rejectListen) => {
  staticServer.once("error", rejectListen);
  staticServer.listen(0, "127.0.0.1", () => {
    staticServer.off("error", rejectListen);
    resolveListen();
  });
});

const staticAddress = staticServer.address();

if (!staticAddress || typeof staticAddress === "string") {
  throw new Error("Static smoke server did not bind to a TCP port");
}

const webUrl = `http://127.0.0.1:${staticAddress.port}/web/index.html?server=${encodeURIComponent(
  transport.url
)}`;

console.log(JSON.stringify({ transportUrl: transport.url, webUrl }));

await new Promise((resolveShutdown) => {
  const shutdown = () => resolveShutdown();

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

await transport.close();
await new Promise((resolveClose) => staticServer.close(resolveClose));
