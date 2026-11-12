import type { Thread } from "../../src/protocol-client/index.js";
import type {
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../../src/main/app-server-manager.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { readNavigationQuestions } from "./ui-polish-visual-navigation.js";

/** Entirely invented editorial material. No network, personal data, or executable task. */
export const readingMarkdown = `# A quieter workspace for careful reading

A useful assistant should leave enough room for the work itself. This synthetic review follows a small team planning a community reading room: no people, addresses, accounts, or real tasks are represented. The aim is to compare the rhythm of long prose with the controls that remain available around it, without turning every sentence into a card or interrupting the argument with a status badge.

## Start with the reader's question

Before arranging the furniture, decide what someone needs to understand. A visitor may be following a detailed explanation, checking a compact result, or returning to a paragraph after writing a reply. Those activities share a need for stable line lengths and recognizable headings, but they do not benefit from identical spacing everywhere. A paragraph should feel connected to its next paragraph; a new section should make a visible promise that the subject is changing.

### Keep context close, not crowded

The conversation can preserve its structure while secondary information stays available on demand. A sidebar supplies orientation, an information panel answers questions about the current conversation, and a pending area explains what has not happened yet. None of those surfaces should pretend to be the answer itself. In this fixture, every pending item is inert and every approval is synthetic.

- Use a clear title to establish the subject.
- Keep supporting evidence adjacent to its explanation.
  - Distinguish a quoted observation from a recommendation.
  - Preserve the order of steps when sequence matters.
- Leave the composer reachable without making it the largest object on screen.

## Compare a few concrete choices

| Surface | Reader's question | Useful signal |
| --- | --- | --- |
| Conversation | What does this mean? | Headings, paragraphs, and evidence |
| Sidebar | Where am I? | Current conversation and project context |
| Pending area | What happens next? | Clear status and deliberate controls |

### A small illustrative example

The following code is display-only material. Nothing in this preview runs it or writes a file.

\`\`\`typescript
const sections = ["Context", "Evidence", "Next steps"];
const outline = sections.map((title, index) => ({
  title,
  order: index + 1,
  state: "draft",
}));
\`\`\`

The table is a summary rather than a replacement for the explanation. When comparing alternatives, the surrounding prose still needs to state why a tradeoff matters. A dense layout may display more lines while making the reading order less obvious; a spacious layout may be pleasant until it hides the result below a fixed control. Measure both the available space and the clarity of the relationships inside it.

> A useful boundary separates two responsibilities. It should not imply that every paragraph is a different task.
>
> This quotation is invented for visual testing, not attributed to a person or publication.

## Read through the transitions

1. Read the opening argument before inspecting the supporting table.
2. Compare the section heading with its first paragraph.
3. Open the conversation information panel and return to the same reading position.
4. Notice whether pending work changes the hierarchy or only the available space.

The most revealing moment is often a transition rather than a still image. Opening a panel may narrow a paragraph, reveal a second scrollbar, or move a heading just enough to make the reader lose their place. A useful review records those changes without assuming that all movement is a defect. The question is whether the reader can continue the same thought and still find the next action when they need it.

### A final checkpoint

This closing section deliberately extends the document beyond the first viewport. It provides another heading and a sustained paragraph for reviewing scroll position, comfortable line length, and the relationship between the bottom of the answer and the composer. All content is deterministic, all names are generic, and no external service is contacted. A screenshot is evidence of this particular synthetic scene, not evidence that a real task was executed.
`;

export function readingRecovery(base: Thread, pending: boolean) {
  if (base.id !== "thread-1") throw new Error("Unexpected reading owner");
  const recovery = nativeRecoveryForThread(
    {
      ...base,
      name:
        base.name && base.name !== "Thread one"
          ? base.name
          : "A quieter workspace for careful reading",
      turns: [
        {
          id: "reading-turn",
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1792033200,
          completedAt: 1792033210,
          durationMs: 10000,
          items: [
            {
              id: "reading-answer",
              type: "agentMessage",
              text: readingMarkdown,
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      ],
    },
    { sandbox: "read-only", approvalPolicy: "on-request" },
  );
  if (pending) {
    const queuedItems = [
      "Compare the paragraph and table spacing.",
      "Summarize the reading-position observations.",
    ].map((text, index) => ({
      id: `reading-queue-${index + 1}`,
      type: "user_message_queued" as const,
      threadId: base.id,
      clientId: `reading-client-${index + 1}`,
      createdAt: `2026-10-15T03:00:0${index + 1}.000Z`,
      input: [{ type: "text" as const, text }],
    }));
    return {
      ...recovery,
      thread: {
        ...recovery.thread,
        items: [...recovery.thread.items, ...queuedItems],
      },
    };
  }
  return recovery;
}

export function readingApprovals(pending: boolean): ApprovalRequestEvent[] {
  return pending
    ? [
        {
          requestId: "reading-synthetic-approval",
          params: {
            threadId: "thread-1",
            turnId: "reading-review-turn",
            itemId: "reading-display-only",
            startedAtMs: 1792033210000,
            environmentId: null,
            reason: "Synthetic preview only. Do not approve or execute.",
            command: "Display-only review of the reading layout",
            cwd: "/synthetic/reading",
            toolName: "run_code",
            toolArguments: {
              code: "// Synthetic preview: no operation is executed.",
            },
            commandActions: [],
            proposedExecpolicyAmendment: null,
            networkApprovalContext: null,
            proposedNetworkPolicyAmendments: null,
          },
        },
      ]
    : [];
}

export function readReadingRequest(
  method: string,
  request: unknown,
  base: Thread,
  pending: boolean,
) {
  if (method === "zen/initialize") {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).length
    )
      throw new Error("Unexpected reading initialize request");
    return { processEpoch: "test-process-epoch" };
  }
  // Reuse the exact owner/shape validator; no write methods fall through.
  readNavigationQuestions(request);
  if (method === "zen/thread/questions/list")
    return readNavigationQuestions(request);
  if (method === "zen/thread/resume" || method === "zen/thread/resume-window")
    return readingRecovery(base, pending);
  if (method === "zen/thread/read")
    return { thread: readingRecovery(base, pending).thread };
  throw new Error(`Unsupported read-only reading protocol: ${method}`);
}

/** AuxiliaryPanel reads existing tabs on mount. The reading scene has none. */
export function readingBrowserCommand(...args: unknown[]) {
  if (args.length !== 2 || args[0] !== "thread-1" || args[1] !== "list")
    throw new Error("Unsupported read-only reading browser command");
  return [];
}

// These methods only expose deterministic fixture values or no-op subscriptions.
// Every other callable bridge surface is denied before reaching its implementation.
export const readingBridgeReads = new Set([
  "computerReadiness.get",
  "chromeBridge.get",
  // FleetComposerSurface reads the local synthetic device list on mount. This
  // is not a wildcard for remote catalogs, thread creation or fleet writes.
  "fleet.status",
  "panels.onOpen",
  "protocol.getStatus",
  "protocol.getPendingApprovals",
  "protocol.request",
  "protocol.onApprovalRequest",
  "protocol.onApprovalResolved",
  "protocol.onStatus",
  "protocol.onNotification",
  "threads.list",
  "imageAttachments.forThread",
  "modelUsage.forThread",
  "projects.get",
  "settings.get",
  "settings.markWorkspaceUsed",
  "titles.get",
  "titles.observe",
  "titles.onChange",
  "triggers.get",
  "triggers.onChange",
  "capabilities.get",
  "capabilities.onChange",
  "plugins.get",
  "plugins.executeCommand",
  "plugins.readHandle",
  "plugins.onChange",
  "information.read",
  "workspaceFiles.applications",
  "workspaceFiles.list",
  "workspaceFiles.read",
  "browserObservation.subscribe",
  "workspaceBrowser.command", // Implementation validates exact owner + list only.
  "workspaceBrowser.onChanged",
  "workspaceBrowser.onFocusAddress",
]);
export function guardReadingBridge<T extends object>(
  bridge: T,
  path = "",
  cache = new WeakMap<object, Map<string, object>>(),
): T {
  const known = cache.get(bridge)?.get(path);
  if (known) return known as T;
  // Production effects depend on bridge identity. A fresh proxy on each read
  // would repeatedly rerun FleetComposerSurface's [api] startup effect.
  const methods = new Map<PropertyKey, { source: unknown; guarded: unknown }>();
  const proxy = new Proxy(bridge, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      const name = path ? `${path}.${String(key)}` : String(key);
      if (typeof value === "function") {
        const method = methods.get(key);
        if (method?.source === value) return method.guarded;
        const guarded = readingBridgeReads.has(name)
          ? value.bind(target)
          : () => {
              throw new Error(`Reading bridge denied: ${name}`);
            };
        methods.set(key, { source: value, guarded });
        return guarded;
      }
      return value && typeof value === "object"
        ? guardReadingBridge(value, name, cache)
        : value;
    },
  });
  const paths = cache.get(bridge) ?? new Map<string, object>();
  paths.set(path, proxy);
  cache.set(bridge, paths);
  return proxy;
}

/** Simulated Host lifecycle only, never a user decision or an operation. */
export function createReadingApprovalFixture(pending: boolean) {
  let snapshot = readingApprovals(pending);
  let replaced = false;
  const requests = new Set<(event: ApprovalRequestEvent) => void>();
  const resolutions = new Set<(event: ApprovalResolvedEvent) => void>();
  return {
    getPendingApprovals: (): ApprovalRequestEvent[] =>
      structuredClone(snapshot),
    onApprovalRequest: (listener: (event: ApprovalRequestEvent) => void) => {
      requests.add(listener);
      return () => {
        requests.delete(listener);
      };
    },
    onApprovalResolved: (listener: (event: ApprovalResolvedEvent) => void) => {
      resolutions.add(listener);
      return () => {
        resolutions.delete(listener);
      };
    },
    replaceRequest: () => {
      if (!pending || replaced)
        throw new Error(
          "Synthetic approval replacement requires an unreplaced pending fixture",
        );
      const old = snapshot[0]!;
      const next: ApprovalRequestEvent = {
        ...structuredClone(old),
        requestId: "reading-synthetic-approval-once",
        params: {
          ...structuredClone(old.params),
          itemId: "reading-display-only-once",
          approvalScope: "once",
          approvalTarget: {
            key: "synthetic-reading-target",
            label: "Synthetic reading-layout preview only",
          },
        },
      };
      replaced = true;
      snapshot = [next];
      const resolved: ApprovalResolvedEvent = {
        requestId: old.requestId,
        threadId: old.params.threadId,
        decision: null,
      };
      for (const listener of [...resolutions])
        listener(structuredClone(resolved));
      for (const listener of [...requests]) listener(structuredClone(next));
      return {
        kind: "synthetic-host-request-replacement" as const,
        oldRequestId: old.requestId,
        newRequestId: next.requestId,
        threadId: next.params.threadId,
        approvalScope: "once" as const,
        approvalTarget: { ...next.params.approvalTarget! },
      };
    },
  };
}
