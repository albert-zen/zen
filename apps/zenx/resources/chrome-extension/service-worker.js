const NATIVE_HOST = "com.zenx.chrome_bridge";
const PROTOCOL_VERSION = 2;
const READY_TIMEOUT_MS = 5000;
let connection;
let actionChain = Promise.resolve();

chrome.action.onClicked.addListener(() => {
  actionChain = actionChain.then(handleAction, handleAction);
});

async function handleAction() {
  if (connection !== undefined) {
    await disconnect(connection);
    return;
  }
  const session = {
    port: chrome.runtime.connectNative(NATIVE_HOST),
    tabs: new Map(),
    changed: new Set(),
    owned: new Set(),
    attachments: new Map(),
    detaching: new Map(),
    published: false,
  };
  connection = session;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ZenX did not answer the Chrome connector")),
        READY_TIMEOUT_MS,
      );
      session.rejectReady = reject;
      session.port.onMessage.addListener((message) => {
        if (connection !== session) return;
        if (
          message?.type === "ready" &&
          message.protocolVersion === PROTOCOL_VERSION &&
          message.scope === "browser"
        ) {
          clearTimeout(timer);
          resolve();
        } else if (message?.type === "cdp-command" && session.published) {
          void runCommand(session, message);
        }
      });
      session.port.onDisconnect.addListener(() => {
        if (connection !== session) return;
        clearTimeout(timer);
        reject(
          new Error(
            chrome.runtime.lastError?.message ?? "ZenX connector closed",
          ),
        );
        // Invalidate immediately. Cleanup joins the action chain so a new connection
        // cannot inherit an attach that is still completing for this generation.
        void disconnect(session);
      });
      session.port.postMessage({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        scope: "browser",
        extensionVersion: chrome.runtime.getManifest().version,
      });
    });
    const tabs = await chrome.tabs.query({});
    if (connection !== session) return;
    for (const tab of tabs) {
      if (!session.changed.has(tab.id) && supported(tab, session))
        session.tabs.set(tab.id, publicTab(tab));
    }
    session.published = true;
    session.port.postMessage({
      type: "browser-connected",
      tabs: [...session.tabs.values()],
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#16784a" });
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setTitle({ title: "Disconnect Chrome from ZenX" });
  } catch (error) {
    await disconnect(session);
    if (connection !== undefined) return;
    await chrome.action.setBadgeBackgroundColor({ color: "#a33a3a" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: `ZenX connection failed: ${describeError(error)}`,
    });
  }
}

chrome.tabs.onCreated.addListener(updateTab);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) =>
  updateTab(tab, changeInfo),
);
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = connection;
  if (session === undefined) return;
  session.changed.add(tabId);
  removeTab(session, tabId);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = connection;
  if (
    session?.tabs.has(source.tabId) &&
    session.attachments.has(source.tabId)
  ) {
    session.port.postMessage({
      type: "cdp-event",
      tabId: source.tabId,
      method,
      params: params ?? {},
    });
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const session = connection;
  if (
    session === undefined ||
    session.detaching.has(source.tabId) ||
    !session.attachments.has(source.tabId)
  )
    return;
  if (reason === "target_closed") {
    session.attachments.delete(source.tabId);
    removeTab(session, source.tabId);
    return;
  }
  // Cancel in Chrome's debugger banner revokes the entire browser connection.
  void disconnect(session);
});

function updateTab(tab, changeInfo = {}) {
  const session = connection;
  if (session === undefined) return;
  session.changed.add(tab.id);
  if (!supported(tab, session)) {
    removeTab(session, tab.id);
    return;
  }
  const previous = session.tabs.get(tab.id);
  const next = publicTab({
    ...tab,
    title: changeInfo.title ?? previous?.title ?? tab.title,
    url: changeInfo.url ?? previous?.url ?? tab.url,
  });
  session.tabs.set(tab.id, next);
  if (
    session.published &&
    (previous?.url !== next.url || previous?.title !== next.title)
  ) {
    session.port.postMessage({ type: "tab-updated", tab: next });
  }
}

function removeTab(session, tabId) {
  if (
    session.tabs.delete(tabId) &&
    session.published &&
    connection === session
  ) {
    session.port.postMessage({ type: "tab-removed", tabId });
  }
  void detach(session, tabId);
}

async function attach(session, tabId) {
  let operation = session.attachments.get(tabId);
  if (operation === undefined) {
    operation = chrome.debugger.attach({ tabId }, "1.3");
    session.attachments.set(tabId, operation);
    operation.catch(() => {
      if (session.attachments.get(tabId) === operation)
        session.attachments.delete(tabId);
    });
  }
  await operation;
  if (
    connection !== session ||
    !session.tabs.has(tabId) ||
    session.detaching.has(tabId)
  ) {
    await detach(session, tabId);
    throw new Error("Chrome browser connection changed");
  }
}

function detach(session, tabId) {
  const existing = session.detaching.get(tabId);
  if (existing !== undefined) return existing;
  const operation = session.attachments.get(tabId);
  if (operation === undefined) return Promise.resolve();
  const cleanup = (async () => {
    try {
      await operation;
      await chrome.debugger.detach({ tabId });
    } catch {
      // Closed tabs and failed attaches already have no debugger connection.
    } finally {
      session.attachments.delete(tabId);
      session.detaching.delete(tabId);
    }
  })();
  session.detaching.set(tabId, cleanup);
  return cleanup;
}

async function runCommand(session, message) {
  if (
    typeof message.requestId !== "string" ||
    typeof message.method !== "string"
  )
    return;
  try {
    let result;
    if (message.method === "Target.createTarget") {
      const url = message.params?.url;
      if (
        typeof url !== "string" ||
        !/^about:blank#zenx-pending-[a-f0-9-]+$/u.test(url)
      )
        throw new Error("Invalid ZenX browser creation marker");
      const tab = await chrome.tabs.create({ url, active: false });
      if (connection !== session) return; // Never remove a tab on disconnect, including a late create.
      session.owned.add(tab.id);
      updateTab(tab);
      result = { targetId: `chrome-tab-${tab.id}` };
    } else {
      const tabId = message.tabId;
      if (!session.tabs.has(tabId))
        throw new Error("Chrome tab is unavailable");
      // Recheck the actual URL before debugger access; tab navigation events can lag.
      const tab = await chrome.tabs.get(tabId);
      if (connection !== session || !supported(tab, session))
        throw new Error("Chrome tab is unavailable");
      await attach(session, tabId);
      result = await chrome.debugger.sendCommand(
        { tabId },
        message.method,
        message.params ?? {},
      );
      if (!session.tabs.has(tabId)) throw new Error("Chrome tab was removed");
    }
    if (connection === session)
      session.port.postMessage({
        type: "cdp-result",
        requestId: message.requestId,
        result: result ?? {},
      });
  } catch (error) {
    if (connection === session)
      session.port.postMessage({
        type: "cdp-result",
        requestId: message.requestId,
        error: { code: -32000, message: describeError(error) },
      });
  }
}

function disconnect(session) {
  if (session.closing !== undefined) return session.closing;
  if (connection === session) connection = undefined;
  session.rejectReady?.(new Error("Chrome disconnected"));
  session.port.disconnect();
  session.closing = Promise.all(
    [...session.attachments.keys()].map((tabId) => detach(session, tabId)),
  ).then(async () => {
    if (connection !== undefined) return;
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Connect Chrome to ZenX" });
  });
  // Reconnect waits for old pending debugger attaches to be released.
  actionChain = actionChain.then(
    () => session.closing,
    () => session.closing,
  );
  return session.closing;
}

function supported(tab, session) {
  return (
    Number.isInteger(tab?.id) &&
    !tab.incognito &&
    (/^https?:\/\//u.test(tabUrl(tab)) ||
      (session.owned.has(tab.id) &&
        /^about:blank(?:#zenx-pending-[a-f0-9-]+)?$/u.test(tabUrl(tab))))
  );
}
function tabUrl(tab) {
  // Newly created tabs can report only pendingUrl until the first commit.
  return (!tab.url || tab.url === "about:blank") &&
    typeof tab.pendingUrl === "string"
    ? tab.pendingUrl
    : (tab.url ?? "");
}
function publicTab(tab) {
  return {
    id: tab.id,
    title: typeof tab.title === "string" ? tab.title.slice(0, 4096) : "",
    url: tabUrl(tab).slice(0, 32768),
  };
}
function describeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
