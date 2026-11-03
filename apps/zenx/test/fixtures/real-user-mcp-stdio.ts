import { createRealUserMcpHost } from "./real-user-mcp-host.js";
import { serveBoundUserMcpStdio } from "../../src/main/user-mcp.js";
const root = process.env.ZEN_MCP_FIXTURE_ROOT;
if (!root) throw new Error("Explicit private fixture root required");
const host = await createRealUserMcpHost(root);
const connection = await serveBoundUserMcpStdio({
  ...host,
  owner: { kind: "thread", threadId: host.threadId },
});
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    await connection.close();
    await host.close();
  })());
process.stdin.once("end", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
