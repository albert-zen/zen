import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import type { ZenAppServer } from "../../../../src/app-server.js";
import { ModelReferenceRegistry } from "../../../../src/model-references.js";
import type {
  ApprovalHandler,
  ToolEnvironment,
  ToolInvocation,
  PreparedToolInvocation,
} from "../../../../src/tool.js";
import { validateBoardOwner, type BoardOwner } from "../board-host.js";
import type { BoardHostService } from "./board-host-service.js";
import { withNativeCapabilityArguments } from "./capability-tool-executor.js";
import { invokeModelToolFacade } from "./capabilities/model-tool-facade.js";
import {
  mapUserMcpReferences,
  mapUserMcpReferenceSchema,
} from "./user-mcp-references.js";

const names = [
  "zenx_threads_read",
  "zenx_board_read",
  "zenx_board_put",
  "zenx_self_control_sidebar_read",
  "zenx_self_control_sidebar_update",
] as const;
type Name = (typeof names)[number];
const fields: Record<Name, readonly string[]> = {
  zenx_threads_read: [
    "maxTurns",
    "maxItemsPerTurn",
    "granularity",
    "cursor",
    "turn",
    "item",
    "through",
  ],
  zenx_board_read: ["view", "instanceKey"],
  zenx_board_put: ["snapshot", "document"],
  zenx_self_control_sidebar_read: ["includeInformation", "cursor", "pageSize"],
  zenx_self_control_sidebar_update: ["snapshot", "patch"],
};
export interface BoundUserMcpOptions {
  /** The existing Host, not a new runtime or a data-directory locator. */
  app: Pick<
    ZenAppServer,
    "readThread" | "subscribe" | "beginHostOperation" | "dispatchHostTool"
  >;
  capabilities: { onChange(listener: () => void): () => void };
  board: Pick<BoardHostService, "readOwner"> & {
    options: { rooms: Pick<BoardHostService["options"]["rooms"], "onChange"> };
  };
  /** The exact ToolEnvironment already passed to this Host AgentRuntime. */
  tools: ToolEnvironment;
  /** Existing createZenXHostToolEnvironment currentGenerationToken, not a new lease. */
  capabilityGeneration(): string;
  /** Established by the trusted Host launcher, never by MCP arguments. */
  owner: BoardOwner;
  /** Required one-way lifetime of this explicitly authorized connection. */
  signal: AbortSignal;
  /** Existing generation-bound Host approval UI/protocol handler, never MCP-authored. */
  requestApproval?: ApprovalHandler;
}

/** The SDK owns MCP protocol; this adapter only binds existing Host authority. */
export async function createBoundUserMcpServer(options: BoundUserMcpOptions) {
  const owner = Object.freeze(validateBoardOwner(options.owner));
  const generation = options.capabilityGeneration();
  const revoked = new AbortController();
  const lifetime = AbortSignal.any([options.signal, revoked.signal]);
  const references = new ModelReferenceRegistry();
  const epoch = randomUUID();
  const referencePrefix = `mcp:${epoch}:`;
  const encodeReference = (ref: unknown) => {
    if (typeof ref !== "string" || !/^r[1-9][0-9]*$/u.test(ref))
      throw new Error("Host returned an invalid typed reference");
    return referencePrefix + ref;
  };
  const decodeReference = (ref: unknown) => {
    if (
      typeof ref !== "string" ||
      !ref.startsWith(referencePrefix) ||
      !/^r[1-9][0-9]*$/u.test(ref.slice(referencePrefix.length))
    )
      throw new Error(
        "Reference belongs to another or retired MCP connection; read again before making a deliberate update",
      );
    return ref.slice(referencePrefix.length);
  };
  const scope = references.scope(owner.threadId);
  const threadRef = scope.bind("threads", "thread", {
    id: owner.threadId,
    device: "local",
  });
  const roomRef =
    owner.kind === "room"
      ? scope.bind("rooms", "room", { id: owner.roomId })
      : undefined;
  const server = new Server(
    { name: "zen-bound-user-tools", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools are bound to one Host-authorized conversation. Read the complete Board document before replacing it. Snapshots are immutable, connection-local and never confer permission. CAS conflicts require a fresh read and deliberate merge. No human Board events, model execution, reconnect or mutation retry is provided.",
    },
  );
  const definitions = new Map(
    options.tools.definitions
      .filter((tool) => names.includes(tool.name as Name))
      .map((tool) => {
        const projected = structuredClone(tool);
        const name = tool.name as Name;
        const properties = projected.inputSchema.properties as Record<
          string,
          object
        >;
        mapUserMcpReferenceSchema(
          projected.inputSchema,
          `^mcp:${epoch}:r[1-9][0-9]*$`,
        );
        const required = Array.isArray(projected.inputSchema.required)
          ? projected.inputSchema.required.filter((key) =>
              fields[name].includes(String(key)),
            )
          : [];
        return [
          name,
          {
            name,
            description: `Bound conversation only. ${projected.description}`,
            inputSchema: {
              type: "object" as const,
              properties: Object.fromEntries(
                Object.entries(properties).filter(([key]) =>
                  fields[name].includes(key),
                ),
              ),
              required,
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: !name.endsWith("_put") && !name.endsWith("_update"),
              openWorldHint: false,
            },
          } satisfies Tool,
        ] as const;
      }),
  );
  const revoke = (reason: unknown) =>
    revoked.abort(reason instanceof Error ? reason : new Error(String(reason)));
  const checkGeneration = () => {
    if (options.capabilityGeneration() !== generation)
      revoke(
        new Error(
          "Host capability generation changed; establish a new connection",
        ),
      );
  };
  const assertLive = async () => {
    checkGeneration();
    lifetime.throwIfAborted();
    await options.board.readOwner(owner);
    checkGeneration();
    lifetime.throwIfAborted();
  };
  // Observe loss, not only the next call. Re-enabling/rejoining never revives this binding.
  const disposers: Array<() => void> = [];
  const roomChanges = options.board.options.rooms.onChange;
  if (owner.kind === "room" && !roomChanges)
    throw new Error("Bound Room MCP requires current membership observation");
  disposers.push(
    options.app.subscribe((event) => {
      if (!("threadId" in event) || event.threadId !== owner.threadId) return;
      if (
        event.type === "thread_settings_updated" ||
        (event.type === "thread_archived_updated" && event.archived) ||
        (event.type === "thread_deleted_updated" && event.deleted)
      )
        revoke(
          new Error(
            "Bound Thread ownership or permissions changed; establish a new connection",
          ),
        );
    }),
  );
  if (owner.kind === "room")
    disposers.push(
      roomChanges!(() => {
        void assertLive().catch(revoke);
      }),
    );
  disposers.push(
    options.capabilities.onChange(() => {
      // Same-name replacement/data reset must retire old snapshots too.
      revoke(
        new Error(
          "Host capability publication changed; establish a new connection",
        ),
      );
    }),
  );
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    revoke(new Error("Bound MCP connection closed"));
    for (const release of disposers.splice(0)) release();
  };
  server.onclose = dispose;
  try {
    await assertLive();
  } catch (error) {
    dispose();
    throw error;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    checkGeneration();
    return { tools: lifetime.aborted ? [] : [...definitions.values()] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name as Name;
    // Unknown names are MCP protocol errors, not a successful tools/call result.
    if (!definitions.has(name))
      throw new McpError(
        ErrorCode.InvalidParams,
        "Tool is not exposed by this bound MCP connection",
      );
    let dispatched = false;
    let lease:
      ReturnType<BoundUserMcpOptions["app"]["beginHostOperation"]> | undefined;
    try {
      await assertLive();
      const args = structuredClone(request.params.arguments ?? {});
      if (Object.keys(args).some((key) => !fields[name].includes(key)))
        throw new Error(
          "Only bound tool arguments are accepted; owner, Thread, device and native revision cannot be supplied",
        );
      mapUserMcpReferences(name, args, "input", decodeReference);
      const signal = AbortSignal.any([lifetime, extra.signal]);
      const thread = await options.app.readThread(owner.threadId);
      await assertLive();
      lease = options.app.beginHostOperation("other", "mcp/bound-tool");
      const bound =
        name === "zenx_threads_read"
          ? { ...args, ref: threadRef }
          : name === "zenx_board_read"
            ? {
                ...args,
                owner: roomRef
                  ? { kind: "room", room: roomRef }
                  : { kind: "thread" },
              }
            : name === "zenx_self_control_sidebar_read"
              ? {
                  ...args,
                  ...(args.cursor === undefined
                    ? { scope: roomRef ?? "self" }
                    : {}),
                }
              : args;
      const invocation: ToolInvocation = {
        name,
        callId: `mcp:${randomUUID()}`,
        arguments: bound,
        threadId: owner.threadId,
        cwd: thread.cwd,
        sandbox: thread.sandbox,
        outputAudience: "program",
        task: { waitForCompletion: true },
        signal,
      };
      const result = await invokeModelToolFacade({
        invocation,
        epoch,
        references,
        dispatch: async (native) => {
          // A valid ref is not permission to switch the connection's fixed owner.
          const target = name.startsWith("zenx_board_")
            ? name === "zenx_board_put"
              ? (native.arguments.document as Record<string, unknown>)?.owner
              : native.arguments.owner
            : name.startsWith("zenx_self_control_sidebar_")
              ? native.arguments.scope
              : undefined;
          const expected = name.startsWith("zenx_board_")
            ? owner
            : {
                kind: owner.kind,
                id: owner.kind === "room" ? owner.roomId : owner.threadId,
              };
          if (
            target !== undefined &&
            JSON.stringify(target) !== JSON.stringify(expected)
          )
            throw new Error(
              "Snapshot belongs to a different conversation owner",
            );
          await assertLive();
          let prepared: PreparedToolInvocation | undefined;
          let launched = false;
          try {
            prepared = options.tools.prepare(
              withNativeCapabilityArguments(native),
              { targetRouting: false },
            );
            if ((await options.tools.admitInherited(prepared)) !== "accept")
              throw new Error("This Host tool is denied by current policy");
            const decision = await options.tools.admit(prepared, {
              policy:
                thread.approvalPolicy === "never"
                  ? "full_access"
                  : "ask_unknown",
              ...(options.requestApproval === undefined
                ? {}
                : { requestApproval: options.requestApproval }),
              approvalRequest: {
                threadId: owner.threadId,
                turnId: native.callId,
                itemId: native.callId,
                callId: native.callId,
                toolName: native.name,
                toolArguments: native.arguments,
                command: native.name,
                cwd: thread.cwd,
                signal,
              },
            });
            if (decision !== "accept" && decision !== "acceptForSession")
              throw new Error("This Host tool was not approved");
            if ((await options.tools.admitInherited(prepared)) !== "accept")
              throw new Error("Host tool permission changed before dispatch");
            await assertLive();
            const admitted = prepared;
            const execution = await options.app.dispatchHostTool(thread, () => {
              // No await between the actual Host generation fence and launch.
              checkGeneration();
              signal.throwIfAborted();
              dispatched = true;
              launched = true;
              return options.tools.execute(admitted);
            });
            return await execution.result;
          } finally {
            if (prepared && !launched) options.tools.discard(prepared);
          }
        },
      });
      let output = result.output;
      if (result.exitCode === 0) {
        const value = JSON.parse(output);
        mapUserMcpReferences(name, value, "output", encodeReference);
        output = JSON.stringify(value);
      }
      return {
        content: [{ type: "text" as const, text: output }],
        isError: result.exitCode !== 0,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              (error instanceof Error
                ? error.message
                : "Bound Host tool failed") +
              (dispatched &&
              ["zenx_board_put", "zenx_self_control_sidebar_update"].includes(
                request.params.name,
              )
                ? ". The write was dispatched and its outcome may be unconfirmed. Read current state; do not retry automatically."
                : ""),
          },
        ],
        isError: true,
      };
    } finally {
      lease?.release();
    }
  });
  return {
    server,
    async close() {
      dispose();
      await server.close();
    },
  };
}

/** Host embedding entry point. It never locates/opens a journal or launches a Host. */
export async function serveBoundUserMcpStdio(
  options: BoundUserMcpOptions & { stdin?: Readable; stdout?: Writable },
) {
  const connection = await createBoundUserMcpServer(options);
  await connection.server.connect(
    new StdioServerTransport(options.stdin, options.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
  );
  return connection;
}
