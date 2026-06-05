import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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

async function main() {
  try {
  const indexResponse = await fetch(webUrl);
  const appResponse = await fetch(
    new URL("/web/app.js", `http://127.0.0.1:${staticAddress.port}`)
  );

  if (!indexResponse.ok) {
    throw new Error(`Web UI index smoke failed with HTTP ${indexResponse.status}`);
  }

  if (!appResponse.ok) {
    throw new Error(`Web UI app smoke failed with HTTP ${appResponse.status}`);
  }

  const indexHtml = await indexResponse.text();
  const appJs = await appResponse.text();

  if (!indexHtml.includes("id=\"server-url\"")) {
    throw new Error("Web UI smoke did not find the server URL input");
  }

  if (!appJs.includes("BrowserAppServerTransportClient")) {
    throw new Error("Web UI smoke did not load the real transport client");
  }

  const result = await runStaticWebUiSmoke(webUrl, transport.url);

  console.log(
    JSON.stringify({
      transportUrl: transport.url,
      webUrl,
      threadId: result.threadId,
      timelineText: result.timelineText,
      connectionStatus: result.connectionStatus
    })
  );
} finally {
  await transport.close();
  await new Promise((resolveClose) => staticServer.close(resolveClose));
}
}

async function runStaticWebUiSmoke(webUrl, transportUrl) {
  const previousGlobals = {
    document: globalThis.document,
    EventSource: globalThis.EventSource,
    location: globalThis.location,
    window: globalThis.window
  };
  const document = new SmokeDocument();
  const location = {
    href: webUrl,
    search: new URL(webUrl).search,
    assign(nextUrl) {
      this.href = nextUrl;
      this.search = new URL(nextUrl).search;
    }
  };
  const window = {
    addEventListener() {},
    localStorage: new SmokeLocalStorage(),
    location
  };

  globalThis.document = document;
  globalThis.location = location;
  globalThis.window = window;
  globalThis.EventSource = SmokeEventSource;

  try {
    await import(`../../web/app.js?smoke=${Date.now()}`);
    await waitForText(document.byId("connection-status"), "client: connected");

    const message = document.byId("message");
    message.value = "run shell smoke";
    await document.byId("composer").dispatch("submit", {
      preventDefault() {}
    });
    await waitForText(document.byId("timeline"), "Shell completed");
    await waitForText(document.byId("timeline"), "web-smoke");

    const connectionStatus = document.byId("connection-status").textContent;

    if (!connectionStatus.includes("Real transport")) {
      throw new Error(`Web UI did not stay in real transport mode: ${connectionStatus}`);
    }

    const threadId = document.byId("thread-id").textContent;

    if (!threadId.startsWith("smoke-thread-")) {
      throw new Error(`Web UI did not render the real thread id: ${threadId}`);
    }

    return {
      connectionStatus,
      threadId,
      timelineText: document.byId("timeline").textContent
    };
  } finally {
    globalThis.document = previousGlobals.document;
    globalThis.EventSource = previousGlobals.EventSource;
    globalThis.location = previousGlobals.location;
    globalThis.window = previousGlobals.window;
  }
}

async function waitForText(element, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (element.textContent.includes(expected)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for Web UI text: ${expected}`);
}

class SmokeDocument {
  constructor() {
    this.elements = new Map(
      [
        "new-thread",
        "connect",
        "disconnect",
        "runtime-mode",
        "server-url",
        "connection-status",
        "composer",
        "send-message",
        "message",
        "timeline",
        "thread-id",
        "thread-status",
        "turn-count",
        "item-count"
      ].map((id) => [id, new SmokeElement(id)])
    );
  }

  querySelector(selector) {
    if (!selector.startsWith("#")) {
      return null;
    }

    return this.byId(selector.slice(1));
  }

  createElement(tagName) {
    return new SmokeElement(tagName);
  }

  byId(id) {
    const element = this.elements.get(id);

    if (!element) {
      throw new Error(`Missing smoke DOM element: ${id}`);
    }

    return element;
  }
}

class SmokeElement {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.disabled = false;
    this.listeners = new Map();
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.type = "button";
    this.value = "";
    this._innerHTML = "";
    this._textContent = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this._textContent = value;
    this.children = [];
  }

  get textContent() {
    return [
      this._textContent,
      ...this.children.map((child) => child.textContent)
    ].filter((text) => text.length > 0).join("\n");
  }

  set textContent(value) {
    this._textContent = String(value);
    this._innerHTML = "";
    this.children = [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    this.children.push(...children);
    this.scrollHeight = this.children.length;
  }

  async dispatch(type, event = {}) {
    const listeners = this.listeners.get(type) ?? [];

    for (const listener of listeners) {
      await listener(event);
    }
  }

  replaceChildren(...children) {
    this.children = children;
    this._innerHTML = "";
    this._textContent = "";
    this.scrollHeight = children.length;
  }
}

class SmokeLocalStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

class SmokeEventSource {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onerror = null;
    this.listeners = new Map();
    this.controller = new AbortController();
    void this.connect();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.controller.abort();
  }

  async connect() {
    try {
      const response = await fetch(this.url, {
        headers: { accept: "text/event-stream" },
        signal: this.controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`EventSource failed with HTTP ${response.status}`);
      }

      this.onopen?.(new Event("open"));
      await this.readEvents(response.body);
    } catch (cause) {
      if (this.controller.signal.aborted) {
        return;
      }

      this.onerror?.(cause);
    }
  }

  async readEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.controller.signal.aborted) {
        const result = await reader.read();

        if (result.done) {
          return;
        }

        buffer += decoder.decode(result.value, { stream: true });
        buffer = this.consume(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  consume(buffer) {
    let remaining = buffer.replaceAll("\r\n", "\n");
    let separator = remaining.indexOf("\n\n");

    while (separator >= 0) {
      const rawEvent = remaining.slice(0, separator);
      remaining = remaining.slice(separator + 2);
      separator = remaining.indexOf("\n\n");

      const type =
        rawEvent
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? "message";
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");

      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data });
      }
    }

    return remaining;
  }
}

await main();
