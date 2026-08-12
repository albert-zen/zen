import { createHash, randomUUID } from "node:crypto";

import type {
  BrowserInspection,
  BrowserScreenshotArtifact,
  BrowserTabSummary,
  BrowserTargetFingerprint,
  ZenXBrowserBackend,
} from "./browser-provider.js";
import {
  BrowserScreenshotArtifactStore,
  assertBrowserTabCapacity,
  MAX_BROWSER_TABS_GLOBAL,
  MAX_BROWSER_TABS_PER_SESSION,
  redactBrowserUrl,
} from "./browser-provider.js";
import {
  type ExternalProviderProcessRunner,
  parseExternalJson,
} from "./external-provider.js";

const PLAYWRIGHT_PROVIDER_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_PLAYWRIGHT_VISIBLE_TEXT = 8_000;
const MAX_PLAYWRIGHT_TARGETS = 128;
const MAX_PLAYWRIGHT_SCREENSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PLAYWRIGHT_PAGES = MAX_BROWSER_TABS_GLOBAL;
const MAX_PLAYWRIGHT_PAGE_KEY_LENGTH = 128;
const MAX_PLAYWRIGHT_PAGE_URL_LENGTH = 8_192;
const MAX_PLAYWRIGHT_PAGE_TITLE_LENGTH = 256;

interface PlaywrightTabState {
  tabId: string;
  tabKey: string;
  documentKey: string;
  index: number;
  documentVersion: number;
  observation?: PlaywrightObservation;
}

interface PlaywrightSessionState {
  sessionId: string;
  cliSessionName: string;
  opened: boolean;
  closed: boolean;
  lifecycleRevision: number;
  operationTail: Promise<void>;
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
  tabKey: string;
  documentKey: string;
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
  readonly #verifyExecutable?: () => Promise<void>;
  readonly #runtimeExecutable?: string;
  readonly #bindBeforeSpawn?: () => Promise<() => Promise<void>>;
  readonly #sessions = new Map<string, PlaywrightSessionState>();
  readonly #artifacts: BrowserScreenshotArtifactStore;
  #reservedOpenTabs = 0;

  constructor(options: {
    executable: string;
    runner: ExternalProviderProcessRunner;
    cwd: string;
    artifactDirectory?: string;
    verifyExecutable?: () => Promise<void>;
    runtimeExecutable?: string;
    bindBeforeSpawn?: () => Promise<() => Promise<void>>;
  }) {
    this.#executable = options.executable;
    this.#runner = options.runner;
    this.#cwd = options.cwd;
    this.#verifyExecutable = options.verifyExecutable;
    this.#runtimeExecutable = options.runtimeExecutable;
    this.#bindBeforeSpawn = options.bindBeforeSpawn;
    this.#artifacts = new BrowserScreenshotArtifactStore(
      options.artifactDirectory,
    );
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    const session = this.#requireSession(sessionId);
    return await this.#enqueue(session, signal, async (revision) => {
      const pages = await this.#pageStates(session, signal);
      this.#assertSession(session, revision, signal);
      this.#reconcileTabs(session, pages);
      return pages.map((page) => {
        const state = session.tabs.get(page.tabKey);
        if (state === undefined)
          throw new Error("Playwright tab reconciliation failed");
        return pageSummary(sessionId, state.tabId, page);
      });
    });
  }

  async open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const session = this.#session(sessionId);
    return await this.#enqueue(session, signal, async (revision) => {
      if (session.opened) {
        const existingPages = await this.#pageStates(session, signal);
        this.#assertSession(session, revision, signal);
        this.#reconcileTabs(session, existingPages);
      }
      assertBrowserTabCapacity(
        this.#tabCount() + this.#reservedOpenTabs + 1,
        session.tabs.size + 1,
      );
      this.#reservedOpenTabs += 1;
      try {
        if (!session.opened) {
          const response = await this.#run(session, ["open", url], signal);
          requirePlaywrightOpenEnvelope(response, session.cliSessionName);
          session.opened = true;
        } else {
          await this.#run(session, ["tab-new", url], signal);
        }
        const pages = await this.#pageStates(session, signal);
        this.#assertSession(session, revision, signal);
        this.#reconcileTabs(session, pages);
        const current = pages.find((page) => page.current) ?? pages.at(-1);
        if (current === undefined)
          throw new Error("Playwright opened no browser tab");
        const state = session.tabs.get(current.tabKey);
        if (state === undefined)
          throw new Error("Playwright tab mapping is missing");
        return pageSummary(sessionId, state.tabId, current);
      } finally {
        this.#reservedOpenTabs -= 1;
      }
    });
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    return await this.#enqueue(session, signal, async (revision) => {
      await this.#select(session, tab, signal);
      this.#invalidate(tab);
      await this.#run(session, ["goto", url], signal);
      this.#assertSession(session, revision, signal);
      return await this.#summary(sessionId, session, tab, signal);
    });
  }

  async inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    return await this.#enqueue(session, signal, async (revision) => {
      await this.#select(session, tab, signal);
      const beforeSnapshot = await this.#currentPage(session, tab, signal);
      const observationDocumentVersion = tab.documentVersion;
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
        if (node.ref === undefined || dom === undefined || !dom.visible)
          continue;
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
      const beforeScreenshot = await this.#currentPage(session, tab, signal);
      if (pageIdentity(beforeSnapshot) !== pageIdentity(beforeScreenshot)) {
        this.#invalidate(tab);
        throw new Error(
          "Playwright page changed during inspection; inspect again",
        );
      }
      const screenshot = await this.#screenshot(
        session,
        tab,
        observationId,
        signal,
      );
      const afterScreenshot = await this.#currentPage(session, tab, signal);
      if (pageIdentity(beforeScreenshot) !== pageIdentity(afterScreenshot)) {
        await this.#artifacts.removeArtifact(
          screenshot.artifactPath,
          screenshot.observationId,
        );
        this.#invalidate(tab);
        throw new Error(
          "Playwright page changed during screenshot; inspect again",
        );
      }
      this.#assertSession(session, revision, signal);
      const summary = await this.#summary(sessionId, session, tab, signal);
      const finalPage = await this.#currentPage(session, tab, signal);
      if (
        pageIdentity(beforeSnapshot) !== pageIdentity(finalPage) ||
        pageIdentity(beforeScreenshot) !== pageIdentity(finalPage) ||
        tab.documentVersion !== observationDocumentVersion
      ) {
        await this.#artifacts.removeArtifact(
          screenshot.artifactPath,
          screenshot.observationId,
        );
        this.#invalidate(tab);
        throw new Error(
          "Playwright page changed before inspection publication; inspect again",
        );
      }
      tab.observation = {
        id: observationId,
        documentVersion: observationDocumentVersion,
        targets,
      };
      return {
        ...summary,
        observationId,
        documentVersion: observationDocumentVersion,
        visibleText: visible.join("\n").slice(0, MAX_PLAYWRIGHT_VISIBLE_TEXT),
        targets: [...targets].map(([targetId, target]) => ({
          targetId,
          role: target.role,
          name: target.name,
          actions: [...target.actions],
        })),
        screenshot,
      };
    });
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    return await this.#enqueue(session, signal, async (revision) => {
      const target = requireObservedTarget(
        tab,
        observationId,
        targetId,
        "click",
      );
      await this.#select(session, tab, signal);
      await this.#revalidateTarget(session, target, "click", signal);
      this.#invalidate(tab);
      await this.#run(session, ["click", target.ref], signal);
      this.#assertSession(session, revision, signal);
      return await this.#summary(sessionId, session, tab, signal);
    });
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
    return await this.#enqueue(session, signal, async (revision) => {
      const target = requireObservedTarget(
        tab,
        observationId,
        targetId,
        "type",
      );
      await this.#select(session, tab, signal);
      await this.#revalidateTarget(session, target, "type", signal);
      this.#invalidate(tab);
      await this.#run(session, ["fill", target.ref, text], signal);
      if (submit) await this.#run(session, ["press", "Enter"], signal);
      this.#assertSession(session, revision, signal);
      return await this.#summary(sessionId, session, tab, signal);
    });
  }

  async closeTab(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { session, tab } = this.#requireTab(sessionId, tabId);
    await this.#enqueue(session, signal, async (revision) => {
      await this.#select(session, tab, signal);
      await this.#run(session, ["tab-close", String(tab.index)], signal);
      this.#assertSession(session, revision, signal);
      session.tabs.delete(tab.tabKey);
      await this.#artifacts.clearScope(`${sessionId}/${tabId}`);
    });
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<number> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return 0;
    return await this.#enqueue(
      session,
      signal,
      async () => {
        const closedTabs = session.tabs.size;
        session.closed = true;
        session.lifecycleRevision += 1;
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
          if (this.#sessions.get(sessionId) === session)
            this.#sessions.delete(sessionId);
          await this.#artifacts.clearScope(sessionId);
        }
        return closedTabs;
      },
      true,
    );
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()]) {
      await this.closeSession(sessionId).catch(() => undefined);
    }
    await this.#artifacts.close();
  }

  async #run(
    session: PlaywrightSessionState,
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs = PLAYWRIGHT_PROVIDER_TIMEOUT_MS,
    maxOutputBytes = 512 * 1024,
  ): Promise<Record<string, unknown>> {
    try {
      await this.#verifyExecutable?.();
      const result = await this.#runner.run(
        this.#executable,
        ["--json", `-s=${session.cliSessionName}`, ...args],
        {
          cwd: this.#cwd,
          timeoutMs,
          signal,
          maxOutputBytes,
          runtimeExecutable: this.#runtimeExecutable,
          bindBeforeSpawn: this.#bindBeforeSpawn,
          verifyBeforeSpawn: this.#verifyExecutable,
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
        session.closed = true;
        session.lifecycleRevision += 1;
        void this.#bestEffortCancel(session);
      }
      throw error;
    }
  }

  async #screenshot(
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    observationId: string,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotArtifact> {
    await this.#select(session, tab, signal);
    const response = await this.#run(
      session,
      [
        "run-code",
        "async page => await page.screenshot({ type: 'png' }).then(buffer => buffer.toString('base64'))",
      ],
      signal,
      PLAYWRIGHT_PROVIDER_TIMEOUT_MS,
      MAX_PLAYWRIGHT_SCREENSHOT_OUTPUT_BYTES,
    );
    if (typeof response.result !== "string") {
      throw new Error(
        "Unsupported playwright-cli JSON schema: screenshot result must be base64",
      );
    }
    signal?.throwIfAborted();
    const png = Buffer.from(response.result, "base64");
    const artifact = await this.#artifacts.write(
      `${session.sessionId}/${tab.tabId}`,
      observationId,
      png,
    );
    try {
      signal?.throwIfAborted();
    } catch (error) {
      await this.#artifacts.removeArtifact(
        artifact.artifactPath,
        artifact.observationId,
      );
      throw error;
    }
    return artifact;
  }

  async #bestEffortCancel(session: PlaywrightSessionState): Promise<void> {
    await this.#runner
      .run(
        this.#executable,
        ["--json", `-s=${session.cliSessionName}`, "close"],
        {
          cwd: this.#cwd,
          timeoutMs: PLAYWRIGHT_CLOSE_TIMEOUT_MS,
          runtimeExecutable: this.#runtimeExecutable,
          bindBeforeSpawn: this.#bindBeforeSpawn,
          verifyBeforeSpawn: this.#verifyExecutable,
        },
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
        "async page => await Promise.all(page.context().pages().map(async (candidate, index) => ({ index, title: (await candidate.title()).slice(0, 256), url: candidate.url(), current: candidate === page, tabKey: await candidate.evaluate(() => { const key = '__zenx_tab_key'; if (typeof window.name === 'string' && window.name.startsWith('__zenx_tab_')) return window.name; const value = '__zenx_tab_' + crypto.randomUUID(); window.name = value; return value; }), documentKey: await candidate.evaluate(() => { const key = '__zenx_document_key'; const current = globalThis[key]; if (typeof current === 'string') return current; const value = crypto.randomUUID(); Object.defineProperty(globalThis, key, { value, writable: false, configurable: false }); return value; }) })))",
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
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_PLAYWRIGHT_PAGES ||
      parsed.length > MAX_BROWSER_TABS_PER_SESSION ||
      !parsed.every(isPlaywrightPageState)
    ) {
      throw new Error(
        "Unsupported playwright-cli JSON schema: invalid page state result",
      );
    }
    const keys = new Set<string>();
    const documentKeys = new Set<string>();
    const indexes = new Set<number>();
    let currentCount = 0;
    for (const page of parsed) {
      if (
        keys.has(page.tabKey) ||
        documentKeys.has(page.documentKey) ||
        indexes.has(page.index)
      ) {
        throw new Error(
          "Unsupported playwright-cli JSON schema: duplicate page identity",
        );
      }
      keys.add(page.tabKey);
      documentKeys.add(page.documentKey);
      indexes.add(page.index);
      if (page.current) currentCount += 1;
    }
    if (parsed.length > 0 && currentCount !== 1) {
      throw new Error(
        "Unsupported playwright-cli JSON schema: exactly one page must be current",
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
      (node.disabled === true) !== target.disabled ||
      fingerprint.actions.length !== target.actions.length ||
      !fingerprint.actions.every((candidate) =>
        target.actions.includes(candidate),
      ) ||
      !fingerprint.actions.includes(action)
    ) {
      throw new Error(
        "Playwright target identity, visibility, or actions changed; inspect again",
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
    const keys = new Set(pages.map((page) => page.tabKey));
    for (const [tabId, tab] of session.tabs) {
      if (!keys.has(tab.tabKey)) session.tabs.delete(tabId);
    }
    for (const page of pages) {
      const existing = session.tabs.get(page.tabKey);
      if (existing === undefined) {
        const tabId = randomUUID();
        session.tabs.set(page.tabKey, {
          tabId,
          tabKey: page.tabKey,
          documentKey: page.documentKey,
          index: page.index,
          documentVersion: 0,
        });
      } else {
        if (existing.documentKey !== page.documentKey) {
          existing.documentKey = page.documentKey;
          this.#invalidate(existing);
        }
        existing.index = page.index;
      }
    }
  }

  async #select(
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    signal?: AbortSignal,
  ): Promise<void> {
    const pages = await this.#pageStates(session, signal);
    this.#reconcileTabs(session, pages);
    if (session.tabs.get(tab.tabKey) !== tab) {
      throw new Error("Playwright tab identity changed; inspect again");
    }
    await this.#run(session, ["tab-select", String(tab.index)], signal);
    const current = await this.#currentPage(session, tab, signal);
    if (!current.current || pageIdentity(current) !== tabIdentity(tab)) {
      throw new Error(
        "Playwright selected page is not the requested tab; retry",
      );
    }
  }

  async #summary(
    sessionId: string,
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const pages = await this.#pageStates(session, signal);
    const page = pages.find((candidate) => candidate.tabKey === tab.tabKey);
    if (page === undefined)
      throw new Error("Playwright browser tab was closed");
    if (!page.current)
      throw new Error("Playwright requested tab is not selected");
    return pageSummary(sessionId, tab.tabId, page);
  }

  async #currentPage(
    session: PlaywrightSessionState,
    tab: PlaywrightTabState,
    signal?: AbortSignal,
  ): Promise<PlaywrightPageState> {
    const pages = await this.#pageStates(session, signal);
    const page = pages.find((candidate) => candidate.tabKey === tab.tabKey);
    if (page === undefined)
      throw new Error("Playwright browser tab was closed");
    if (!page.current)
      throw new Error("Playwright requested tab is not selected");
    return page;
  }

  #session(sessionId: string): PlaywrightSessionState {
    let session = this.#sessions.get(sessionId);
    if (session !== undefined) return session;
    session = {
      sessionId,
      cliSessionName: `${playwrightSessionName(sessionId)}-${randomUUID().slice(0, 8)}`,
      opened: false,
      closed: false,
      lifecycleRevision: 0,
      operationTail: Promise.resolve(),
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
    const tab = [...session.tabs.values()].find(
      (candidate) => candidate.tabId === tabId,
    );
    if (tab === undefined) {
      throw new Error("Browser tab is unknown or scoped to another session");
    }
    return { session, tab };
  }

  async #enqueue<T>(
    session: PlaywrightSessionState,
    signal: AbortSignal | undefined,
    operation: (revision: number) => Promise<T>,
    allowClosed = false,
  ): Promise<T> {
    const run = session.operationTail.then(
      async () => {
        if (!allowClosed)
          this.#assertSession(session, session.lifecycleRevision, signal);
        return await operation(session.lifecycleRevision);
      },
      async () => {
        if (!allowClosed)
          this.#assertSession(session, session.lifecycleRevision, signal);
        return await operation(session.lifecycleRevision);
      },
    );
    session.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  #assertSession(
    session: PlaywrightSessionState,
    revision: number,
    signal?: AbortSignal,
  ): void {
    signal?.throwIfAborted();
    if (
      session.closed ||
      session.lifecycleRevision !== revision ||
      this.#sessions.get(session.sessionId) !== session
    ) {
      throw new Error("Playwright browser session is closed or stale");
    }
  }

  #tabCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) count += session.tabs.size;
    return count;
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
    (page.index as number) >= 0 &&
    (page.index as number) < MAX_PLAYWRIGHT_PAGES &&
    typeof page.tabKey === "string" &&
    page.tabKey.length > 0 &&
    page.tabKey.length <= MAX_PLAYWRIGHT_PAGE_KEY_LENGTH &&
    typeof page.documentKey === "string" &&
    page.documentKey.length > 0 &&
    page.documentKey.length <= MAX_PLAYWRIGHT_PAGE_KEY_LENGTH &&
    typeof page.title === "string" &&
    page.title.length <= MAX_PLAYWRIGHT_PAGE_TITLE_LENGTH &&
    typeof page.url === "string" &&
    page.url.length <= MAX_PLAYWRIGHT_PAGE_URL_LENGTH &&
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
    url: redactBrowserUrl(page.url),
    loading: false,
  };
}

function pageIdentity(page: PlaywrightPageState): string {
  return `${page.tabKey}\u0000${page.documentKey}`;
}

// Capacity is checked before dispatch and includes opens from other sessions
// that have reserved a slot but have not yet returned their page list.
// This keeps the provider's one-session operations from bypassing the global cap.

function tabIdentity(tab: PlaywrightTabState): string {
  return `${tab.tabKey}\u0000${tab.documentKey}`;
}

export function playwrightSessionName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `zenx-${digest.slice(0, 24)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
