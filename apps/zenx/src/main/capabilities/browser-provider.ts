import { randomUUID } from "node:crypto";

import type { BrowserWindow } from "electron";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

export interface BrowserTabSummary {
  sessionId: string;
  tabId: string;
  title: string;
  url: string;
  loading: boolean;
}

export interface BrowserInspection extends BrowserTabSummary {
  visibleText: string;
  targets: Array<{
    selector: string;
    role: string;
    name: string;
    value?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    screenPoint?: { x: number; y: number };
  }>;
}

export interface ZenXBrowserBackend {
  listTabs(sessionId: string): Promise<BrowserTabSummary[]>;
  open(sessionId: string, url: string): Promise<BrowserTabSummary>;
  navigate(
    sessionId: string,
    tabId: string,
    url: string,
  ): Promise<BrowserTabSummary>;
  inspect(sessionId: string, tabId: string): Promise<BrowserInspection>;
  click(
    sessionId: string,
    tabId: string,
    selector: string,
  ): Promise<BrowserTabSummary>;
  type(
    sessionId: string,
    tabId: string,
    selector: string,
    text: string,
    submit: boolean,
  ): Promise<BrowserTabSummary>;
  close(): Promise<void> | void;
}

export const browserCapabilityManifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: "browser",
  displayName: "Browser",
  version: "1.0.0",
  description:
    "A dedicated ephemeral ZenX browser session with bounded DOM inspection and narrow navigation and interaction tools.",
  permissions: [
    {
      id: "browser.tabs.read",
      title: "Inspect browser tabs",
      description:
        "List tabs and inspect bounded visible text and interactive targets.",
      scope: "browser-session",
    },
    {
      id: "browser.navigate",
      title: "Open and navigate pages",
      description:
        "Open URLs or navigate an explicitly targeted ZenX browser tab.",
      scope: "browser-session",
    },
    {
      id: "browser.interact",
      title: "Interact with pages",
      description:
        "Click and type into an explicitly targeted visible page element.",
      scope: "browser-session",
    },
  ],
  tools: [
    {
      name: "browser_list_tabs",
      description:
        "List bounded metadata for tabs in one explicit ZenX browser session. Cookies, storage, headers, and history are never returned.",
      inputSchema: objectSchema({ sessionId: stringSchema() }, ["sessionId"]),
      permissions: ["browser.tabs.read"],
      maxOutputBytes: 8 * 1024,
    },
    {
      name: "browser_open",
      description:
        "Open an http(s) URL in a new visible tab in an explicit ephemeral ZenX browser session. Returns the new tabId.",
      inputSchema: objectSchema(
        { sessionId: stringSchema(), url: stringSchema() },
        ["sessionId", "url"],
      ),
      permissions: ["browser.navigate"],
    },
    {
      name: "browser_navigate",
      description:
        "Navigate one explicit ZenX browser session/tab target to an http(s) URL.",
      inputSchema: browserTargetSchema({ url: stringSchema() }, ["url"]),
      permissions: ["browser.navigate"],
    },
    {
      name: "browser_inspect",
      description:
        "Inspect bounded visible text and clickable/typeable CSS targets in one explicit ZenX browser tab; never returns raw HTML, cookies, storage, headers, or unrelated tabs.",
      inputSchema: browserTargetSchema(),
      permissions: ["browser.tabs.read"],
      maxOutputBytes: 12 * 1024,
    },
    {
      name: "browser_click",
      description:
        "Click a CSS target returned by browser_inspect in one explicit session/tab.",
      inputSchema: browserTargetSchema({ selector: stringSchema() }, [
        "selector",
      ]),
      permissions: ["browser.interact"],
    },
    {
      name: "browser_type",
      description:
        "Replace the value of an input target returned by browser_inspect in one explicit session/tab, optionally submitting its form.",
      inputSchema: browserTargetSchema(
        {
          selector: stringSchema(),
          text: stringSchema(),
          submit: { type: "boolean" },
        },
        ["selector", "text"],
      ),
      permissions: ["browser.interact"],
    },
  ],
  resources: [
    {
      id: "safe-browser-use",
      kind: "skill",
      title: "Safe browser use",
      description:
        "Instructions for targeted, inspect-before-act browser automation.",
      content:
        "Choose a stable sessionId for the task. List or open tabs, then inspect the exact tab before clicking or typing. Re-inspect after navigation or any DOM-changing action. Use only selectors returned by inspect, keep outputs bounded, and never ask for cookies, storage state, auth headers, or hidden page content.",
    },
    {
      id: "browser-research",
      kind: "prompt",
      title: "Browser research prompt",
      description: "A reusable prompt for evidence-backed browser research.",
      content:
        "Research the requested topic in the dedicated ZenX browser session. Keep a list of the exact page URLs inspected, distinguish page evidence from inference, and summarize only visible content returned by browser_inspect.",
    },
  ],
};

export class BrowserZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = browserCapabilityManifest;
  readonly #backend: ZenXBrowserBackend;

  constructor(backend: ZenXBrowserBackend) {
    this.#backend = backend;
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    const sessionId = requiredTargetId(invocation.arguments, "sessionId");
    switch (toolName) {
      case "browser_list_tabs":
        return await this.#backend.listTabs(sessionId);
      case "browser_open":
        return await this.#backend.open(
          sessionId,
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
        );
      case "browser_navigate":
        return await this.#backend.navigate(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
        );
      case "browser_inspect":
        return await this.#backend.inspect(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
        );
      case "browser_click":
        return await this.#backend.click(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredString(invocation.arguments, "selector"),
        );
      case "browser_type":
        return await this.#backend.type(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredString(invocation.arguments, "selector"),
          requiredString(invocation.arguments, "text", true),
          optionalBoolean(invocation.arguments, "submit") ?? false,
        );
      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}

interface BrowserTab {
  sessionId: string;
  tabId: string;
  window: BrowserWindow;
}

export class ElectronBrowserBackend implements ZenXBrowserBackend {
  readonly #tabs = new Map<string, BrowserTab>();

  async listTabs(sessionId: string): Promise<BrowserTabSummary[]> {
    assertTargetId(sessionId, "sessionId");
    return [...this.#tabs.values()]
      .filter((tab) => tab.sessionId === sessionId && !tab.window.isDestroyed())
      .map((tab) => summarizeTab(tab));
  }

  async open(sessionId: string, url: string): Promise<BrowserTabSummary> {
    assertTargetId(sessionId, "sessionId");
    const tabId = randomUUID();
    const { BrowserWindow } = await import("electron");
    const window = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 640,
      minHeight: 480,
      show: true,
      title: "ZenX Browser",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `zenx-capability-${sessionId}`,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const tab = { sessionId, tabId, window };
    this.#tabs.set(tabId, tab);
    window.once("closed", () => this.#tabs.delete(tabId));
    try {
      await window.loadURL(url);
      return summarizeTab(tab);
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    await tab.window.loadURL(url);
    return summarizeTab(tab);
  }

  async inspect(sessionId: string, tabId: string): Promise<BrowserInspection> {
    const tab = this.#requireTab(sessionId, tabId);
    const inspected = (await tab.window.webContents.executeJavaScript(
      INSPECT_SCRIPT,
      true,
    )) as {
      visibleText: string;
      targets: BrowserInspection["targets"];
    };
    const contentBounds = tab.window.getContentBounds();
    return {
      ...summarizeTab(tab),
      visibleText: inspected.visibleText.slice(0, 8_000),
      targets: inspected.targets.slice(0, 80).map((target) => ({
        ...target,
        ...(target.bounds === undefined
          ? {}
          : {
              screenPoint: {
                x: Math.round(
                  contentBounds.x + target.bounds.x + target.bounds.width / 2,
                ),
                y: Math.round(
                  contentBounds.y + target.bounds.y + target.bounds.height / 2,
                ),
              },
            }),
      })),
    };
  }

  async click(
    sessionId: string,
    tabId: string,
    selector: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    const found = (await tab.window.webContents.executeJavaScript(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.scrollIntoView({ block: "center", inline: "center" }); element.click(); return true; })()`,
      true,
    )) as boolean;
    if (!found) throw new Error(`Browser target not found: ${selector}`);
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async type(
    sessionId: string,
    tabId: string,
    selector: string,
    text: string,
    submit: boolean,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    const found = (await tab.window.webContents.executeJavaScript(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false; element.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set; setter?.call(element, ${JSON.stringify(text)}); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); if (${JSON.stringify(submit)}) element.form?.requestSubmit(); return true; })()`,
      true,
    )) as boolean;
    if (!found) throw new Error(`Browser text target not found: ${selector}`);
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  close(): void {
    for (const tab of this.#tabs.values()) {
      if (!tab.window.isDestroyed()) tab.window.destroy();
    }
    this.#tabs.clear();
  }

  #requireTab(sessionId: string, tabId: string): BrowserTab {
    assertTargetId(sessionId, "sessionId");
    assertTargetId(tabId, "tabId");
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.sessionId !== sessionId ||
      tab.window.isDestroyed()
    ) {
      throw new Error(`Unknown browser target ${sessionId}/${tabId}`);
    }
    return tab;
  }
}

const INSPECT_SCRIPT = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const selector = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current instanceof Element && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + String(siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const elements = [...document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[tabindex]")]
    .filter(visible)
    .slice(0, 80);
  return {
    visibleText: (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 8000),
    targets: elements.map((element) => ({
      selector: selector(element),
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
      name: (element.getAttribute("aria-label") ?? element.textContent ?? element.getAttribute("placeholder") ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
      ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? { value: element.value.slice(0, 160) } : {}),
      bounds: (() => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
    })),
  };
})()`;

function summarizeTab(tab: BrowserTab): BrowserTabSummary {
  return {
    sessionId: tab.sessionId,
    tabId: tab.tabId,
    title: tab.window.getTitle().slice(0, 256),
    url: redactUrl(tab.window.webContents.getURL()),
    loading: tab.window.webContents.isLoading(),
  };
}

function safeBrowserUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZenX browser only opens http(s) URLs");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("ZenX browser URLs must not contain credentials");
  }
  for (const key of url.searchParams.keys()) {
    if (
      /(?:auth|code|credential|key|password|secret|session|token)/iu.test(key)
    ) {
      throw new Error(
        `ZenX browser URL contains sensitive query parameter ${key}`,
      );
    }
  }
  return url.toString();
}

function redactUrl(raw: string): string {
  if (raw.length === 0) return "";
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (
      /(?:auth|code|credential|key|password|secret|session|token)/iu.test(key)
    ) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString().slice(0, 2048);
}

function requiredTargetId(
  arguments_: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(arguments_, key);
  assertTargetId(value, key);
  return value;
}

function assertTargetId(value: string, key: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(value)) {
    throw new Error(`${key} must contain only letters, numbers, _ or -`);
  }
}

function requiredString(
  arguments_: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = arguments_[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function optionalBoolean(
  arguments_: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = arguments_[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function browserTargetSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return objectSchema(
    { sessionId: stringSchema(), tabId: stringSchema(), ...properties },
    ["sessionId", "tabId", ...required],
  );
}

async function settlePage(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    window.webContents.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
