/** Isolated MCP-shaped stdio probe. Never imports a live Host, journal or credential. */
import { pathToFileURL } from "node:url";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const descriptors = [
  {
    name: "zenx_fixture_thread_summary",
    description:
      "Read the one synthetic, process-bound Thread summary. No real user data.",
    inputSchema: emptyObjectSchema,
    annotations,
  },
  {
    name: "zenx_fixture_board_read",
    description:
      "Read a compact synthetic Board summary. No HTML, event execution or answer submission.",
    inputSchema: emptyObjectSchema,
    annotations,
  },
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value) =>
  value === undefined || (object(value) && Object.keys(value).length === 0);
const error = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const toolResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError: false,
});

export function createFixtureSession() {
  let initialized = false;
  return {
    handle(message) {
      if (
        !object(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        ("id" in message &&
          typeof message.id !== "string" &&
          typeof message.id !== "number")
      ) {
        return error(null, -32600, "Invalid JSON-RPC request");
      }
      // Notifications never run tools or change the fixture's scope.
      if (!("id" in message)) return undefined;
      const { id, method, params } = message;
      if (method === "initialize") {
        if (initialized) return error(id, -32600, "Already initialized");
        if (params !== undefined && !object(params))
          return error(id, -32602, "Expected initialization object");
        initialized = true;
        return result(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "zen-readonly-fixture",
            version: "0.0.0-experiment",
          },
          instructions:
            "Synthetic fixture only. No real Host, credentials or write operations are connected.",
        });
      }
      if (!initialized) return error(id, -32002, "Initialize first");
      if (method === "ping") return result(id, {});
      if (method === "tools/list") {
        if (!empty(params))
          return error(
            id,
            -32602,
            "No pagination or scope override in this fixture",
          );
        return result(id, { tools: structuredClone(descriptors) });
      }
      if (method !== "tools/call")
        return error(id, -32601, "Method not available in read-only fixture");
      if (
        !object(params) ||
        Object.keys(params).some(
          (key) => !["name", "arguments"].includes(key),
        ) ||
        !empty(params.arguments)
      ) {
        return error(
          id,
          -32602,
          "Only the fixed empty tool argument object is accepted",
        );
      }
      if (params.name === "zenx_fixture_thread_summary") {
        // A real adapter must obtain this scope from Host admission, never arguments.
        return result(
          id,
          toolResult({
            threadId: "fixture-thread-a",
            title: "Synthetic fixture only",
            status: "idle",
          }),
        );
      }
      if (params.name === "zenx_fixture_board_read") {
        return result(
          id,
          toolResult({
            owner: { kind: "thread", threadId: "fixture-thread-a" },
            title: "Synthetic Board",
            summary: "Read-only capability experiment; not a pending question.",
          }),
        );
      }
      return error(id, -32602, "Unknown fixture tool");
    },
  };
}

export function createFrameReader(onLine, onError) {
  let buffered = "";
  let failed = false;
  return {
    push(chunk) {
      if (failed) return;
      buffered += chunk;
      while (true) {
        const end = buffered.indexOf("\n");
        const frame = end < 0 ? buffered : buffered.slice(0, end);
        if (Buffer.byteLength(frame, "utf8") > 16_384) {
          failed = true;
          buffered = "";
          onError(new Error("Fixture input exceeds 16 KiB"));
          return;
        }
        if (end < 0) return;
        buffered = buffered.slice(end + 1);
        if (frame.trim()) onLine(frame);
      }
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const session = createFixtureSession();
  const write = (value) => {
    if (value !== undefined) process.stdout.write(JSON.stringify(value) + "\n");
  };
  const reader = createFrameReader(
    (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(error(null, -32700, "Invalid JSON"));
        return;
      }
      write(session.handle(message));
    },
    (failure) => {
      process.stderr.write(failure.message + "\n");
      process.exitCode = 1;
      process.stdin.destroy();
    },
  );
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => reader.push(chunk));
}
