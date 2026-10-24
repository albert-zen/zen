/**
 * Review-only prototype. Not registered in the plugin catalog, IPC or app startup.
 * Future self-control integration must obtain the originating client from trusted
 * admission, not arguments, focus, the active window, or a Thread lookup.
 */
import type { ToolInvocation } from "../../../../src/tool.js";

export type SidebarCommand =
  | { action: "show" }
  | { action: "set_fullscreen"; fullscreen: boolean }
  | { action: "open_file"; path: string }
  | { action: "open_website"; url: string }
  | { action: "open_page"; pageId: string }
  | { action: "list_pages" };

export interface SidebarClientIdentity {
  readonly clientId: string;
  readonly generation: string;
  readonly threadId: string;
}
export interface SidebarPage {
  readonly id: string;
  readonly title: string;
}
export interface SidebarDispatchContext extends SidebarClientIdentity {
  readonly canonicalToolCallId: string;
  readonly signal: AbortSignal;
  /** Recheck immediately before effects and after every asynchronous boundary. */
  assertCurrent(): void;
}
export interface SidebarClientPort {
  /** Null after disconnect, unmount or loss of authorization. */
  current(): SidebarClientIdentity | null;
  /** Exact currently registered navigation IDs, not arbitrary routes or tools. */
  pages(): readonly SidebarPage[];
  /**
   * Use existing workspace-file/browser Host handlers. Never evaluate JS, invoke
   * plugin tool commands, open external apps, or bypass their authorization.
   * Resolve only after the target renderer acknowledges applying the command.
   */
  dispatch(
    command: Exclude<SidebarCommand, { action: "list_pages" }>,
    context: SidebarDispatchContext,
  ): Promise<{ status: "applied" }>;
}

type Binding = {
  readonly client: SidebarClientPort;
  readonly identity: SidebarClientIdentity;
  readonly canonicalToolCallId: string;
};

type SidebarAuthorization = (
  command: SidebarCommand,
  invocation: ToolInvocation,
  target: SidebarClientIdentity,
) => Promise<void>;

export class ExperimentalSidebarControl {
  readonly #enabled: boolean;
  readonly #bindings = new WeakMap<ToolInvocation, Binding>();
  readonly #used = new WeakSet<ToolInvocation>();
  readonly #authorize: (
    command: SidebarCommand,
    invocation: ToolInvocation,
    target: SidebarClientIdentity,
  ) => Promise<void>;

  constructor(options: {
    enabled?: boolean;
    /** Required policy port: UI visibility is not file/site access permission. */
    authorize: SidebarAuthorization;
  }) {
    this.#enabled = options.enabled === true;
    this.#authorize = options.authorize;
  }

  /** Host-only, once per exact canonical invocation; never expose over model IPC. */
  bindInvocation(invocation: ToolInvocation, client: SidebarClientPort): void {
    if (!this.#enabled)
      throw new Error("Sidebar control experiment is disabled");
    if (this.#bindings.has(invocation) || this.#used.has(invocation))
      throw new Error("Sidebar invocation is already bound or consumed");
    const identity = client.current();
    if (
      !identity?.clientId ||
      !identity.generation ||
      !invocation.threadId ||
      identity.threadId !== invocation.threadId ||
      !invocation.canonicalToolCallId ||
      invocation.trustedPluginUi
    )
      throw new Error(
        "Sidebar control requires trusted client and Thread provenance",
      );
    invocation.signal.throwIfAborted();
    this.#bindings.set(invocation, {
      client,
      identity: Object.freeze({ ...identity }),
      canonicalToolCallId: invocation.canonicalToolCallId,
    });
  }

  async invoke(invocation: ToolInvocation): Promise<{
    status: "applied" | "listed";
    action: SidebarCommand["action"];
    pages?: readonly SidebarPage[];
  }> {
    if (!this.#enabled)
      throw new Error("Sidebar control experiment is disabled");
    const binding = this.#bindings.get(invocation);
    if (!binding || this.#used.has(invocation))
      throw new Error("No unused trusted client binding for this invocation");
    // Consume even failed calls: callers must make a new canonical tool call.
    // An ambiguous dispatch is never automatically repeated.
    this.#used.add(invocation);
    this.#bindings.delete(invocation);
    const command = parseSidebarCommand(invocation.arguments);
    const assertCurrent = () => {
      invocation.signal.throwIfAborted();
      const current = binding.client.current();
      if (
        !current ||
        current.clientId !== binding.identity.clientId ||
        current.generation !== binding.identity.generation ||
        current.threadId !== binding.identity.threadId ||
        invocation.threadId !== binding.identity.threadId ||
        invocation.canonicalToolCallId !== binding.canonicalToolCallId
      )
        throw new Error(
          "Sidebar target disconnected or changed; command not replayed",
        );
    };
    assertCurrent();
    await this.#authorize(command, invocation, binding.identity);
    assertCurrent();
    if (command.action === "list_pages" || command.action === "open_page") {
      const pages = readPages(binding.client.pages());
      if (command.action === "list_pages")
        return { status: "listed", action: command.action, pages };
      if (!pages.some((page) => page.id === command.pageId))
        throw new Error(
          "Unknown page ID; use list_pages and choose an exact ID",
        );
    }
    try {
      const receipt = await binding.client.dispatch(command, {
        ...binding.identity,
        canonicalToolCallId: binding.canonicalToolCallId,
        signal: invocation.signal,
        assertCurrent,
      });
      assertCurrent();
      if (receipt?.status !== "applied")
        throw new Error("Missing renderer acknowledgment");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Sidebar dispatch outcome is uncertain; do not replay automatically: ${detail}`,
        { cause },
      );
    }
    return { status: "applied", action: command.action };
  }
}

export function parseSidebarCommand(value: unknown): SidebarCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sidebar command");
  const args = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    show: ["action"],
    set_fullscreen: ["action", "fullscreen"],
    open_file: ["action", "path"],
    open_website: ["action", "url"],
    open_page: ["action", "pageId"],
    list_pages: ["action"],
  };
  if (typeof args.action !== "string" || !Object.hasOwn(fields, args.action))
    throw new Error("Unsupported sidebar action");
  const allowed = fields[args.action]!;
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error(
      "Unexpected sidebar argument; client and Thread are Host-owned",
    );
  switch (args.action) {
    case "show":
    case "list_pages":
      return { action: args.action };
    case "set_fullscreen":
      if (typeof args.fullscreen !== "boolean")
        throw new Error("fullscreen must be boolean");
      return { action: args.action, fullscreen: args.fullscreen };
    case "open_file": {
      const path = boundedString(args.path, 4096);
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(path))
        throw new Error("Expected a file path, not a URL");
      return { action: args.action, path };
    }
    case "open_page":
      return { action: args.action, pageId: boundedString(args.pageId, 256) };
    case "open_website": {
      const url = new URL(boundedString(args.url, 8192));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Only credential-free HTTP(S) navigation is supported");
      return { action: args.action, url: url.href };
    }
    default:
      throw new Error("Unsupported sidebar action");
  }
}

function boundedString(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid sidebar string argument");
  return value;
}
function readPages(value: readonly SidebarPage[]): readonly SidebarPage[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Invalid page inventory");
  const pages = value.map((page) => ({
    id: boundedString(page.id, 256),
    title: boundedString(page.title, 256),
  }));
  if (new Set(pages.map((page) => page.id)).size !== pages.length)
    throw new Error("Ambiguous page inventory");
  return pages;
}
