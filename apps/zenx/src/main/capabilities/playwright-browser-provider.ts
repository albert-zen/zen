import { createHash, randomUUID } from "node:crypto";

import type {
  BrowserInspection,
  BrowserTabSummary,
  BrowserTargetFingerprint,
  ZenXBrowserBackend,
} from "./browser-provider.js";
import {
  type ExternalProviderProcessRunner,
  parseExternalJson,
} from "./external-provider.js";

const PLAYWRIGHT_PROVIDER_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_PLAYWRIGHT_VISIBLE_TEXT = 8_000;
const MAX_PLAYWRIGHT_TARGETS = 128;

interface PlaywrightTabState {
  tabId: string;
  index: number;
  documentVersion: number;
  observation?: PlaywrightObservation;
}

interface PlaywrightSessionState {
  sessionId: string;
  cliSessionName: string;
  opened: boolean;
  tabs: Map<string, PlaywrightTabState>;
}

interface PlaywrightObservation {
  id: string;
  documentVersion: number;
  targets: Map<
    string,
    BrowserTargetFingerprint & { ref: string; disabled: boolean }
  >;
}

interface PlaywrightPageState {
  index: number;
  title: string;
  url: string;
  current: boolean;
}

interface PlaywrightAriaNode {
  role: string;
  name?: string;
  ref?: string;
  disabled?: true;
  cursor?: "pointer";
  url?: string;
  placeholder?: string;
  text?: string;
  children?: Array<PlaywrightAriaNode | string>;
}

interface PlaywrightDomMetadata {
  ref: string;
  count: 1;
  visible: boolean;
  tag: string;
  type: string;
  id: string;
  fieldName: string;
  autocomplete: string;
  href: string;
}

export class PlaywrightCliBrowserBackend implements ZenXBrowserBackend {
  readonly #executable: string;
  readonly #runner: ExternalProviderProcessRunner;
  readonly #cwd: string;
  readonly #sessions = new Map<string, PlaywrightSessionState>();

  constructor(options: {
    executable: string;
    runner: ExternalProviderProcessRunner;
    cwd: string;
  }) {
    this.#executable = options.executable;
    this.#runner = options.runner;
    this.#cwd = options.cwd;
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    const session = this.#requireSession(sessionId);
    const pages = await this.#pageStates(session, signal);
    this.#reconcileTabs(session, pages);
    return pages.map((page) => {
      const state = [...session.tabs.values()].find(
        (candidate) => candidate.index === page.index,
      );
      if (state === undefined) {
        throw new Error("Playwright tab reconciliation failed");
      }
      return pageSummary(sessionId, state.tabId, page);
    });
  }

  async open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const session = this.#session(sessionId);
    if (!session.opened) {
      const response = await this.#run(
        session,
        ["open", url],
        signal,
        PLAYWRIGHT_PROVIDER_TIMEOUT_MS,
      );
      requirePlaywrightOpenEnvelope(response, session.cliSessionName);
      session.opened = true;
    } else {
      await this.#run(session, ["tab-new", url], signal);
    }
    const pages = await this.#pageStates(session, signal);
    this.#reconcileTabs(session, pages);
    const current = pages.find((page) => page.current) ?? pages.at(-1);
    if (current === undefined)
      throw new Error("Playwright opened no browser tab");
    const state = [...session.tabs.values()].find(
      (candidate) => candidate.index === current.index,
    );
    if (state === undefined)
      throw new Error("Playwright tab mapping is missing");
    return pageSummary(sessionId, state.tabId, current);
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    await this.#select(session, tab, signal);
    this.#invalidate(tab);
    await this.#run(session, ["goto", url], signal);
    return await this.#summary(sessionId, session, tab, signal);
  }

  async inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    await this.#select(session, tab, signal);
    const snapshot = await this.#snapshot(session, signal);
    const observationId = randomUUID();
    const targets = new Map<
      string,
      BrowserTargetFingerprint & { ref: string; disabled: boolean }
    >();
    const visible: string[] = [];
    const nodes: PlaywrightAriaNode[] = [];
    walkAriaSnapshot(snapshot, (node) => {
      appendVisibleText(visible, node);
      if (node.ref !== undefined && nodes.length < MAX_PLAYWRIGHT_TARGETS) {
        nodes.push(node);
      }
    });
    const metadata = await this.#domMetadata(
      session,
      nodes.flatMap((node) => (node.ref === undefined ? [] : [node.ref])),
      signal,
    );
    for (const node of nodes) {
      const dom = node.ref === undefined ? undefined : metadata.get(node.ref);
      if (node.ref === undefined || dom === undefined || !dom.visible) continue;
      const fingerprint = playwrightTargetFingerprint(node, dom);
      const actions = fingerprint.actions;
      if (actions.length === 0) continue;
      const targetId = randomUUID();
      targets.set(targetId, {
        ref: node.ref,
        ...fingerprint,
        disabled: node.disabled === true,
      });
    }
    tab.observation = {
      id: observationId,
      documentVersion: tab.documentVersion,
      targets,
    };
    const summary = await this.#summary(sessionId, session, tab, signal);
    return {
      ...summary,
      observationId,
      documentVersion: tab.documentVersion,
      visibleText: visible.join("\n").slice(0, MAX_PLAYWRIGHT_VISIBLE_TEXT),
      targets: [...targets].map(([targetId, target]) => ({
        targetId,
        role: target.role,
        name: target.name,
        actions: [...target.actions],
        ...(target.secure ? { secure: true as const } : {}),
      })),
    };
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    const target = requireObservedTarget(tab, observationId, targetId, "click");
    await this.#select(session, tab, signal);
    await this.#revalidateTarget(session, target, "click", signal);
    this.#invalidate(tab);
    await this.#run(session, ["click", target.ref], signal);
    return await this.#summary(sessionId, session, tab, signal);
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    const target = requireObservedTarget(tab, observationId, targetId, "type");
    await this.#select(session, tab, signal);
    await this.#revalidateTarget(session, target, "type", signal);
    this.#invalidate(tab);
    await this.#run(session, ["fill", target.ref, text], signal);
    if (submit) await this.#run(session, ["press", "Enter"], signal);
    return await this.#summary(sessionId, session, tab, signal);
  }

  async closeTab(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    await this.#run(session, ["tab-close", String(tab.index)], signal);
    session.tabs.delete(tabId);
    for (const candidate of session.tabs.values()) {
      if (candidate.index > tab.index) candidate.index -= 1;
    }
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<number> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return 0;
    const closedTabs = session.tabs.size;
    try {
      if (session.opened) {
        await this.#run(
          session,
          ["close"],
          signal,
          PLAYWRIGHT_CLOSE_TIMEOUT_MS,
        );
      }
    } finally {
      session.tabs.clear();
      session.opened = false;
      this.#sessions.delete(sessionId);
    }
    return closedTabs;
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()]) {
      await this.closeSession(sessionId).catch(() => undefined);
    }
  }

  async #run(
    session: PlaywrightSessionState,
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs = PLAYWRIGHT_PROVIDER_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.#runner.run(
        this.#executable,
        ["--json", `-s=${session.cliSessionName}`, ...args],
        {
          cwd: this.#cwd,
          timeoutMs,
          signal,
          maxOutputBytes: 512 * 1024,
        },
      );
      const response = parseExternalJson("playwright-cli", result.stdout);
      if (response.isError === true) {
        throw new Error(
          `playwright-cli: ${String(response.error ?? "unknown provider error")}`,
        );
      }
      return response;
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) {
        if (this.#sessions.get(session.sessionId) === session) {
          this.#sessions.delete(session.sessionId);
        }
        session.opened = false;
        session.tabs.clear();
        void this.#bestEffortCancel(session);
      }
      throw error;
    }
  }

  async #bestEffortCancel(session: PlaywrightSessionState): Promise<void> {
    await this.#runner
      .run(
        this.#executable,
        ["--json", `-s=${session.cliSessionName}`, "close"],
        { cwd: this.#cwd, timeoutMs: PLAYWRIGHT_CLOSE_TIMEOUT_MS },
      )
      .catch(() => undefined);
  }

  async #pageStates(
    session: PlaywrightSessionState,
    signal?: AbortSignal,
  ): Promise<PlaywrightPageState[]> {
    if (!session.opened) return [];
    const response = await this.#run(
      session,
      [
        "run-code",
        "async page => await Promise.all(page.context().pages().map(async (candidate, index) => ({ index, title: await candidate.title(), url: candidate.url(), current: candidate === page })))",
      ],
      signal,
    );
    if (typeof response.result !== "string") {
      throw new Error(
        "Unsupported playwright-cli JSON schema: run-code result must be a JSON string",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.result);
    } catch {
      throw new Error(
        "Unsupported playwright-cli JSON schema: run-code result is not JSON",
      );
    }
    if (!Array.isArray(parsed) || !parsed.every(isPlaywrightPageState)) {
      throw new Error(
        "Unsupported playwright-cli JSON schema: invalid page state result",
      );
    }
    return parsed;
  }

  async #snapshot(
    session: PlaywrightSessionState,
    signal?: AbortSignal,
  ): Promise<PlaywrightAriaNode[]> {
    const response = await this.#run(
      session,
      ["snapshot", "--depth=12"],
      signal,
    );
    return requireAriaSnapshot(response);
  }

  async #revalidateTarget(
    session: PlaywrightSessionState,
    target: BrowserTargetFingerprint & {
      ref: string;
      disabled: boolean;
    },
    action: "click" | "type",
    signal?: AbortSignal,
  ): Promise<void> {
    const snapshot = await this.#snapshot(session, signal);
    const matches: PlaywrightAriaNode[] = [];
    walkAriaSnapshot(snapshot, (node) => {
      if (node.ref === target.ref) matches.push(node);
    });
    if (matches.length !== 1) {
      throw new Error(
        "Playwright target is stale, hidden, missing, or ambiguous; inspect again",
      );
    }
    const node = matches[0]!;
    const metadata = await this.#domMetadata(session, [target.ref], signal);
    const dom = metadata.get(target.ref);
    if (dom === undefined || !dom.visible) {
      throw new Error(
        "Playwright target is stale, hidden, missing, or ambiguous; inspect again",
      );
    }
    const fingerprint = playwrightTargetFingerprint(node, dom);
    if (
      fingerprint.selector !== target.selector ||
      fingerprint.tag !== target.tag ||
      fingerprint.role !== target.role ||
      fingerprint.name !== target.name ||
      fingerprint.type !== target.type ||
      fingerprint.id !== target.id ||
      fingerprint.fieldName !== target.fieldName ||
      fingerprint.autocomplete !== target.autocomplete ||
      fingerprint.href !== target.href ||
      fingerprint.secure !== target.secure ||
      (node.disabled === true) !== target.disabled ||
      fingerprint.actions.length !== target.actions.length ||
      !fingerprint.actions.every((candidate) =>
        target.actions.includes(candidate),
      ) ||
      !fingerprint.actions.includes(action)
    ) {
      throw new Error(
        "Playwright target identity, security, visibility, or actions changed; inspect again",
      );
    }
  }

  async #domMetadata(
    session: PlaywrightSessionState,
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, PlaywrightDomMetadata>> {
    if (refs.length === 0) return new Map();
    const code = `async page => await Promise.all(${JSON.stringify(refs)}.map(async ref => {
      const locator = page.locator('aria-ref=' + ref);
      const count = await locator.count();
      if (count !== 1) return { ref, count };
      const visible = await locator.isVisible();
      const attributes = await locator.evaluate(element => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        id: element.id || '',
        fieldName: element.getAttribute('name') || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        href: element.getAttribute('href') || ''
      }));
      return { ref, count, visible, ...attributes };
    }))`;
    const response = await this.#run(session, ["run-code", code], signal);
    if (typeof response.result !== "string") {
      throw new Error(
        "Unsupported playwright-cli JSON schema: DOM metadata result must be a JSON string",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.result);
    } catch {
      throw new Error(
        "Unsupported playwright-cli JSON schema: DOM metadata result is not JSON",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        "Unsupported playwright-cli JSON schema: DOM metadata must be an array",
      );
    }
    const result = new Map<string, PlaywrightDomMetadata>();
    for (const entry of parsed) {
      if (isPlaywrightDomMetadata(entry)) result.set(entry.ref, entry);
      else if (!isMissingPlaywrightDomMetadata(entry)) {
        throw new Error(
          "Unsupported playwright-cli JSON schema: invalid DOM metadata entry",
        );
      }
    }
    return result;
  }

  #reconcileTabs(
    session: PlaywrightSessionState,
    pages: PlaywrightPageState[],
  ): void {
    const indexes = new Set(pages.map((page) => page.index));
    for (const [tabId, tab] of session.tabs) {
      if (!indexes.has(tab.index)) session.tabs.delete(tabId);
    }
    for (const page of pages) {
      if (![...session.tabs.values()].some((tab) => tab.index === page.index)) {
        const tabId = randomUUID();
        session.tabs.set(tabId, {
          tabId,
          index: page.index,
          documentVersion: 0,
        });
      }
    }
  }

  async #select(
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#run(session, ["tab-select", String(tab.index)], signal);
  }

  async #summary(
    sessionId: string,
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const pages = await this.#pageStates(session, signal);
    const page = pages.find((candidate) => candidate.index === tab.index);
    if (page === undefined)
      throw new Error("Playwright browser tab was closed");
    return pageSummary(sessionId, tab.tabId, page);
  }

  #session(sessionId: string): PlaywrightSessionState {
    let session = this.#sessions.get(sessionId);
    if (session !== undefined) return session;
    session = {
      sessionId,
      cliSessionName: `${playwrightSessionName(sessionId)}-${randomUUID().slice(0, 8)}`,
      opened: false,
      tabs: new Map(),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  #requireSession(sessionId: string): PlaywrightSessionState {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || !session.opened) {
      throw new Error(`Unknown Playwright browser session: ${sessionId}`);
    }
    return session;
  }

  #requireTab(
    sessionId: string,
    tabId: string,
  ): { session: PlaywrightSessionState; tab: PlaywrightTabState } {
    const session = this.#requireSession(sessionId);
    const tab = session.tabs.get(tabId);
    if (tab === undefined) {
      throw new Error("Browser tab is unknown or scoped to another session");
    }
    return { session, tab };
  }

  #invalidate(tab: PlaywrightTabState): void {
    tab.documentVersion += 1;
    tab.observation = undefined;
  }
}

function requirePlaywrightOpenEnvelope(
  response: Record<string, unknown>,
  expectedSession: string,
): void {
  if (
    response.session !== expectedSession ||
    typeof response.result !== "object" ||
    response.result === null
  ) {
    throw new Error(
      "Unsupported playwright-cli JSON schema: invalid open envelope",
    );
  }
}

function requireAriaSnapshot(
  response: Record<string, unknown>,
): PlaywrightAriaNode[] {
  if (!Array.isArray(response.snapshot)) {
    throw new Error(
      "Unsupported playwright-cli JSON schema: snapshot must be an array",
    );
  }
  if (!response.snapshot.every(isPlaywrightAriaNode)) {
    throw new Error(
      "Unsupported playwright-cli JSON schema: invalid ARIA snapshot node",
    );
  }
  return response.snapshot;
}

function isPlaywrightAriaNode(value: unknown): value is PlaywrightAriaNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.role !== "string") return false;
  if (node.ref !== undefined && typeof node.ref !== "string") return false;
  if (
    node.children !== undefined &&
    (!Array.isArray(node.children) ||
      !node.children.every(
        (child) => typeof child === "string" || isPlaywrightAriaNode(child),
      ))
  ) {
    return false;
  }
  return true;
}

function walkAriaSnapshot(
  nodes: readonly PlaywrightAriaNode[],
  visit: (node: PlaywrightAriaNode) => void,
): void {
  const queue = [...nodes];
  while (queue.length > 0) {
    const node = queue.shift()!;
    visit(node);
    for (const child of node.children ?? []) {
      if (typeof child !== "string") queue.push(child);
    }
  }
}

function appendVisibleText(target: string[], node: PlaywrightAriaNode): void {
  if (target.join("\n").length >= MAX_PLAYWRIGHT_VISIBLE_TEXT) return;
  const text = node.text ?? node.name;
  if (typeof text === "string" && text.trim().length > 0) {
    target.push(text.trim().slice(0, 512));
  }
  for (const child of node.children ?? []) {
    if (typeof child === "string" && child.trim().length > 0) {
      target.push(child.trim().slice(0, 512));
    }
  }
}

function playwrightTargetFingerprint(
  node: PlaywrightAriaNode,
  dom: PlaywrightDomMetadata,
): BrowserTargetFingerprint {
  const secure = isSecurePlaywrightNode(node, dom);
  return {
    selector: node.ref!,
    tag: dom.tag,
    role: node.role,
    name: node.name ?? node.placeholder ?? "",
    type: dom.type,
    id: dom.id,
    fieldName: dom.fieldName,
    autocomplete: dom.autocomplete,
    href: dom.href || node.url || "",
    secure,
    actions: playwrightNodeActions(node, dom),
  };
}

function playwrightNodeActions(
  node: PlaywrightAriaNode,
  dom: PlaywrightDomMetadata,
): Array<"click" | "type"> {
  if (node.disabled === true) return [];
  const clickRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "option",
    "radio",
    "switch",
    "tab",
    "searchbox",
    "textbox",
  ]);
  const typeRoles = new Set(["combobox", "searchbox", "textbox"]);
  const nonTypeableInput = new Set([
    "button",
    "checkbox",
    "file",
    "hidden",
    "image",
    "radio",
    "reset",
    "submit",
  ]);
  return [
    ...(clickRoles.has(node.role) || node.cursor === "pointer"
      ? (["click"] as const)
      : []),
    ...(typeRoles.has(node.role) &&
    !(dom.tag === "input" && nonTypeableInput.has(dom.type.toLowerCase()))
      ? (["type"] as const)
      : []),
  ];
}

function isSecurePlaywrightNode(
  node: PlaywrightAriaNode,
  dom: PlaywrightDomMetadata,
): boolean {
  const semantics = `${node.role} ${node.name ?? ""} ${node.placeholder ?? ""}`;
  return (
    dom.type.toLowerCase() === "password" ||
    /(?:^|-)password$/iu.test(dom.autocomplete) ||
    /password|secure/iu.test(semantics)
  );
}

function isPlaywrightDomMetadata(
  value: unknown,
): value is PlaywrightDomMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ref === "string" &&
    entry.count === 1 &&
    typeof entry.visible === "boolean" &&
    typeof entry.tag === "string" &&
    typeof entry.type === "string" &&
    typeof entry.id === "string" &&
    typeof entry.fieldName === "string" &&
    typeof entry.autocomplete === "string" &&
    typeof entry.href === "string"
  );
}

function isMissingPlaywrightDomMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.ref === "string" && entry.count !== 1;
}

function requireObservedTarget(
  tab: PlaywrightTabState,
  observationId: string,
  targetId: string,
  action: "click" | "type",
): BrowserTargetFingerprint & { ref: string; disabled: boolean } {
  const observation = tab.observation;
  if (
    observation === undefined ||
    observation.id !== observationId ||
    observation.documentVersion !== tab.documentVersion
  ) {
    throw new Error("Browser observation is stale or unknown; inspect again");
  }
  const target = observation.targets.get(targetId);
  if (target === undefined) {
    throw new Error("Browser target ID is forged, stale, or unknown");
  }
  if (target.disabled || !target.actions.includes(action)) {
    throw new Error(`Browser target does not support ${action}`);
  }
  return target;
}

function isPlaywrightPageState(value: unknown): value is PlaywrightPageState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const page = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(page.index) &&
    typeof page.title === "string" &&
    typeof page.url === "string" &&
    typeof page.current === "boolean"
  );
}

function pageSummary(
  sessionId: string,
  tabId: string,
  page: PlaywrightPageState,
): BrowserTabSummary {
  return {
    sessionId,
    tabId,
    title: page.title,
    url: page.url,
    loading: false,
  };
}

export function playwrightSessionName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `zenx-${digest.slice(0, 24)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
