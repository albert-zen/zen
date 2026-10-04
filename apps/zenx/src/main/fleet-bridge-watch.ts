import { realpath } from "node:fs/promises";
import { ZenXProtocolClient } from "../protocol-client/protocol-client.js";
import { readZenXConnectionDescriptor } from "../protocol-client/connection-descriptor.js";
export async function watchFleetBridge(
  descriptorFile: string,
  input: unknown,
  emit: (event: unknown) => void,
): Promise<void> {
  const value = input as {
    threadId?: unknown;
    workspace?: unknown;
    includeCurrentTerminal?: unknown;
    observed?: unknown;
  };
  if (
    !value ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    value.threadId.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(value.threadId) ||
    (value.workspace !== undefined &&
      (typeof value.workspace !== "string" ||
        !value.workspace ||
        value.workspace.length > 4096 ||
        /[\x00-\x1f\x7f]/u.test(value.workspace))) ||
    typeof value.includeCurrentTerminal !== "boolean" ||
    !Array.isArray(value.observed) ||
    value.observed.length > 128 ||
    value.observed.some(
      (id) =>
        typeof id !== "string" ||
        !id ||
        id.length > 512 ||
        /[\x00-\x1f\x7f]/u.test(id),
    )
  )
    throw new Error("Invalid Fleet thread subscription");
  const threadId = value.threadId;
  const descriptor = await readZenXConnectionDescriptor(descriptorFile);
  const client = await ZenXProtocolClient.connect({
    url: descriptor.url,
    bearerTokenFile: descriptor.authentication.tokenFile,
    clientInfo: {
      name: "zenx-fleet-watch",
      title: "Fleet Thread watch",
      version: "1",
    },
    reconnect: { maxAttempts: 1 },
  });
  const closed = new Promise<void>((resolve) => {
    client.onStatus((status) => {
      if (status.type === "closed" || status.type === "reconnecting") {
        client.close();
        resolve();
      }
    });
  });
  const close = () => client.close();
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  process.stdout.once("error", close);
  try {
    const before = (
      await client.request("thread/read", { threadId, includeTurns: true })
    ).thread;
    if (
      value.workspace !== undefined &&
      (await realpath(before.cwd)) !==
        (await realpath(value.workspace as string))
    )
      throw new Error("Thread is not in the selected workspace");
    const completed = new Set<string>();
    let recovering = true;
    client.onNotification("turn/started", (event) => {
      if (event.threadId === threadId)
        emit({ type: "active", threadId, turnId: event.turn.id });
    });
    client.onNotification("turn/completed", (event) => {
      if (event.threadId === threadId) {
        if (recovering) completed.add(event.turn.id);
        emit({
          type: "turn",
          threadId,
          turnId: event.turn.id,
          status: event.turn.status,
        });
      }
    });
    const { thread } = await client.request("thread/resume", { threadId });
    emit({ type: "ready", threadId });
    const current = thread.turns.filter((turn) => turn.status === "inProgress");
    for (const turn of current)
      emit({ type: "active", threadId, turnId: turn.id });
    const terminals = thread.turns.filter(
      (turn) => turn.status !== "inProgress",
    );
    const observed = new Set(value.observed as string[]);
    // The initial read happens before resume installs its live subscription.
    // Carry its canonical active identity across that registration gap.
    for (const turn of before.turns)
      if (turn.status === "inProgress") observed.add(turn.id);
    if (value.includeCurrentTerminal && terminals.at(-1))
      observed.add(terminals.at(-1)!.id);
    for (const turn of terminals)
      if (observed.has(turn.id) && !completed.has(turn.id))
        emit({ type: "turn", threadId, turnId: turn.id, status: turn.status });
    recovering = false;
    completed.clear();
    await closed;
  } finally {
    client.close();
    process.removeListener("SIGTERM", close);
    process.removeListener("SIGINT", close);
    process.stdout.removeListener("error", close);
  }
}
