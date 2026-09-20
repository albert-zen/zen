const NATIVE_HOST = "com.zenx.chrome_bridge";
const PROTOCOL_VERSION = 1;
const READY_TIMEOUT_MS = 5000;

let nativePort;
let connectedTabId;
let readyPromise;
let readyResolve;
let readyReject;
let disconnecting = false;
let detachingTabId;
let nativeGeneration = 0;
let actionChain = Promise.resolve();

chrome.action.onClicked.addListener((tab) => {
  actionChain = actionChain.then(
    () => handleAction(tab),
    () => handleAction(tab),
  );
});

async function handleAction(tab) {
  if (typeof tab.id !== "number") return;
  if (connectedTabId === tab.id) {
    await disconnectTab("Disconnected by user");
    return;
  }
  try {
    await ensureNativeReady();
    await detachSelectedTab("A different tab was selected");
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    connectedTabId = tab.id;
    nativePort.postMessage({ type: "tab-attached", tab: publicTab(tab) });
    await showConnected(tab.id);
  } catch (error) {
    await showError(tab.id, error);
    await disconnectTab("Connection failed");
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== connectedTabId || nativePort === undefined) return;
  nativePort.postMessage({
    type: "cdp-event",
    tabId: source.tabId,
    method,
    params: params ?? {},
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === detachingTabId) return;
  if (source.tabId !== connectedTabId) return;
  const previous = connectedTabId;
  connectedTabId = undefined;
  nativePort?.postMessage({ type: "tab-detached", tabId: previous, reason });
  void showDisconnected(previous);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    tabId !== connectedTabId ||
    nativePort === undefined ||
    (changeInfo.title === undefined && changeInfo.url === undefined)
  )
    return;
  nativePort.postMessage({ type: "tab-updated", tab: publicTab(tab) });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === connectedTabId) void disconnectTab("Tab closed");
});

function ensureNativeReady() {
  if (readyPromise !== undefined) return readyPromise;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  const generation = ++nativeGeneration;
  nativePort = port;
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    const timer = setTimeout(
      () => reject(new Error("ZenX did not answer the Chrome connector")),
      READY_TIMEOUT_MS,
    );
    port.onMessage.addListener((message) => {
      if (nativePort !== port || nativeGeneration !== generation) return;
      if (
        message?.type === "ready" &&
        message.protocolVersion === PROTOCOL_VERSION
      ) {
        clearTimeout(timer);
        readyResolve?.();
        return;
      }
      if (message?.type === "cdp-command")
        void runCdpCommand(message, port, generation);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port || nativeGeneration !== generation) return;
      const detail = chrome.runtime.lastError?.message;
      clearTimeout(timer);
      readyReject?.(new Error(detail ?? "ZenX connector closed"));
      nativePort = undefined;
      readyPromise = undefined;
      readyResolve = undefined;
      readyReject = undefined;
      nativeGeneration += 1;
      if (!disconnecting) {
        actionChain = actionChain.then(
          () => detachSelectedTab("ZenX connector closed"),
          () => detachSelectedTab("ZenX connector closed"),
        );
      }
    });
    port.postMessage({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: chrome.runtime.getManifest().version,
    });
  });
  return readyPromise;
}

async function runCdpCommand(message, port, generation) {
  if (
    typeof connectedTabId !== "number" ||
    message.tabId !== connectedTabId ||
    typeof message.requestId !== "string" ||
    typeof message.method !== "string"
  )
    return;
  const tabId = connectedTabId;
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      message.method,
      message.params ?? {},
    );
    if (
      nativePort !== port ||
      nativeGeneration !== generation ||
      connectedTabId !== tabId
    )
      return;
    port.postMessage({
      type: "cdp-result",
      requestId: message.requestId,
      result: result ?? {},
    });
  } catch (error) {
    if (
      nativePort !== port ||
      nativeGeneration !== generation ||
      connectedTabId !== tabId
    )
      return;
    port.postMessage({
      type: "cdp-result",
      requestId: message.requestId,
      error: { code: -32000, message: describeError(error) },
    });
  }
}

async function disconnectTab(reason) {
  if (disconnecting) return;
  disconnecting = true;
  const port = nativePort;
  try {
    await detachSelectedTab(reason);
    port?.disconnect();
  } finally {
    if (nativePort === port) {
      nativePort = undefined;
      readyPromise = undefined;
      readyResolve = undefined;
      readyReject = undefined;
      nativeGeneration += 1;
    }
    disconnecting = false;
  }
}

async function detachSelectedTab(reason) {
  const tabId = connectedTabId;
  if (typeof tabId !== "number") return;
  connectedTabId = undefined;
  detachingTabId = tabId;
  try {
    nativePort?.postMessage({ type: "tab-detached", tabId, reason });
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    await showDisconnected(tabId);
  } finally {
    detachingTabId = undefined;
  }
}

function publicTab(tab) {
  return {
    id: tab.id,
    title: typeof tab.title === "string" ? tab.title.slice(0, 4096) : "",
    url: typeof tab.url === "string" ? tab.url.slice(0, 32768) : "",
  };
}

async function showConnected(tabId) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16784a" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  await chrome.action.setTitle({
    tabId,
    title: "Disconnect this tab from ZenX",
  });
}

async function showDisconnected(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  await chrome.action
    .setTitle({ tabId, title: "Connect this tab to ZenX" })
    .catch(() => undefined);
}

async function showError(tabId, error) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33a3a" });
  await chrome.action.setBadgeText({ tabId, text: "!" });
  await chrome.action.setTitle({
    tabId,
    title: `ZenX connection failed: ${describeError(error)}`,
  });
}

function describeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
