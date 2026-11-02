const NATIVE_HOST = "com.zenx.chrome_bridge";
const PROTOCOL_VERSION = 3;
const READY_TIMEOUT_MS = 5000;
const GROUPING_RESPONSE_BUDGET_MS = 500;
const AUTO_CONNECT_KEY = "zenxBrowserAutoConnect";
const RECONNECT_ALARM = "zenx-browser-reconnect";
let connection;
let actionChain = Promise.resolve();
let autoConnect = false;
let restoreQueued = false;
const storageReady = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get(AUTO_CONNECT_KEY);
  autoConnect = stored[AUTO_CONNECT_KEY] !== false;
})();

chrome.action.onClicked.addListener(() => {
  enqueue(handleAction);
});
chrome.runtime.onStartup.addListener(restoreConnection);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) restoreConnection();
});
restoreConnection();

function enqueue(action) {
  actionChain = actionChain.then(action, action).catch(showConnectionError);
}

function restoreConnection() {
  if (restoreQueued) return;
  restoreQueued = true;
  enqueue(async () => {
    try {
      await storageReady;
      if (!autoConnect) return;
      await ensureReconnectAlarm();
      if (connection === undefined) await connectBrowser();
    } finally {
      restoreQueued = false;
    }
  });
}

async function ensureReconnectAlarm() {
  if (!(await chrome.alarms.get(RECONNECT_ALARM)))
    await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

async function handleAction() {
  await storageReady;
  if (autoConnect) {
    await stopConnecting();
    return;
  }
  await chrome.storage.local.set({ [AUTO_CONNECT_KEY]: true });
  autoConnect = true;
  await ensureReconnectAlarm();
  await connectBrowser();
}

async function stopConnecting(persistedRevocation) {
  // Revoke in memory immediately; cleanup cannot authorize a queued reconnect.
  autoConnect = false;
  const closing =
    connection === undefined ? Promise.resolve() : disconnect(connection);
  await (persistedRevocation ??
    chrome.storage.local.set({ [AUTO_CONNECT_KEY]: false }));
  await chrome.alarms.clear(RECONNECT_ALARM);
  await closing;
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Connect this browser to ZenX" });
}

async function showConnectionError(error) {
  await chrome.action.setBadgeBackgroundColor({ color: "#a33a3a" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({
    title: `ZenX connection failed: ${describeError(error)}${autoConnect ? ". Will reconnect automatically; click to disconnect." : ""}`,
  });
}

async function connectBrowser() {
  if (!autoConnect || connection !== undefined) return;
  let identity;
  try {
    identity = await browserIdentity();
  } catch (error) {
    await showConnectionError(error);
    return;
  }
  const session = {
    port: undefined,
    tabs: new Map(),
    recentUrls: new Map(),
    removed: new Set(),
    changed: new Set(),
    owned: new Set(),
    groups: new Map(),
    groupingChain: Promise.resolve(),
    attachments: new Map(),
    detaching: new Map(),
    published: false,
  };
  connection = session;
  try {
    session.port = chrome.runtime.connectNative(NATIVE_HOST);
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
        } else if (message?.type === "connection-rejected") {
          clearTimeout(timer);
          reject(
            new Error(
              typeof message.message === "string"
                ? message.message
                : "Another browser is connected",
            ),
          );
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
        ...identity,
      });
    });
    const tabs = await chrome.tabs.query({});
    if (connection !== session) return;
    for (const tab of tabs) {
      if (!session.changed.has(tab.id) && supported(tab, session)) {
        session.tabs.set(tab.id, publicTab(tab));
        session.recentUrls.set(tab.id, tabUrl(tab));
      }
    }
    session.published = true;
    session.port.postMessage({
      type: "browser-connected",
      tabs: [...session.tabs.values()],
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#16784a" });
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setTitle({
      title: "Disconnect this browser from ZenX",
    });
  } catch (error) {
    await disconnect(session);
    if (connection !== undefined) return;
    await showConnectionError(error);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const session = connection;
  if (session === undefined) return;
  session.removed.delete(tab.id);
  session.recentUrls.delete(tab.id);
  updateTab(tab);
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) =>
  updateTab(tab, changeInfo),
);
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = connection;
  if (session === undefined) return;
  session.changed.add(tabId);
  session.removed.add(tabId);
  session.recentUrls.delete(tabId);
  session.owned.delete(tabId);
  removeTab(session, tabId);
});
chrome.tabGroups?.onRemoved.addListener((group) => {
  const session = connection;
  if (session === undefined) return;
  for (const [windowId, groupId] of session.groups) {
    if (groupId === group.id) session.groups.delete(windowId);
  }
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
    session.removed.add(source.tabId);
    session.recentUrls.delete(source.tabId);
    session.owned.delete(source.tabId);
    removeTab(session, source.tabId);
    return;
  }
  // Cancel in Chrome's debugger banner revokes the entire browser connection.
  // The Chrome debugger banner is an explicit revocation, not a transport loss.
  autoConnect = false;
  // Start persistence in this Chrome event callback, before waiting for a
  // pending attach/disconnect or a queued native handshake to settle.
  const persistedRevocation = chrome.storage.local.set({
    [AUTO_CONNECT_KEY]: false,
  });
  void persistedRevocation.catch(showConnectionError);
  void disconnect(session);
  enqueue(() => stopConnecting(persistedRevocation));
});

function updateTab(tab, changeInfo = {}) {
  const session = connection;
  if (session === undefined) return;
  if (session.removed.has(tab.id)) return;
  session.changed.add(tab.id);
  const previous = session.tabs.get(tab.id);
  const candidate = {
    ...tab,
    title: changeInfo.title ?? previous?.title ?? tab.title,
    url:
      changeInfo.url ??
      session.recentUrls.get(tab.id) ??
      previous?.url ??
      tab.url,
  };
  if (Number.isInteger(tab.id))
    session.recentUrls.set(tab.id, tabUrl(candidate));
  if (!supported(candidate, session)) {
    removeTab(session, tab.id);
    return;
  }
  const next = publicTab(candidate);
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
      // Creation already succeeded. Grouping is display metadata, never a reason
      // to report creation failure or to create another tab on retry.
      result = {
        targetId: `chrome-tab-${tab.id}`,
        grouping: await boundedGrouping(
          session,
          tab,
          typeof message.params?.zenxSessionId === "string"
            ? message.params.zenxSessionId
            : "default",
        ),
      };
    } else if (message.method === "Target.closeTarget") {
      if (!session.owned.has(message.tabId))
        throw new Error("Only this connection's created pages may be retired");
      await chrome.tabs.remove(message.tabId);
      session.owned.delete(message.tabId);
      result = { success: true };
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

async function boundedGrouping(session, tab, taskId) {
  if (session.groupingStalled)
    return {
      status: "unavailable",
      reason:
        "A prior grouping command is unresolved; this created tab remains usable",
    };
  const ticket = { active: true };
  const grouping = session.groupingChain.then(() =>
    groupCreatedTab(session, tab, ticket, taskId),
  );
  session.groupingChain = grouping.then(() => {});
  let timer;
  try {
    return await Promise.race([
      grouping,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          ticket.active = false;
          session.groupingStalled ??= ticket;
          resolve({
            status: "unknown",
            reason:
              "Grouping response timed out; a sent command may still finish. Tab creation succeeded; do not recreate it.",
          });
        }, GROUPING_RESPONSE_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The native group command cannot be cancelled. Observe settlement but do
    // not follow a timeout with naming, regrouping, rollback, or another create.
    void grouping.finally(() => {
      if (session.groupingStalled === ticket)
        session.groupingStalled = undefined;
    });
  }
}

async function groupCreatedTab(session, tab, ticket, taskId) {
  let groupId;
  const abandoned = () => !ticket.active || connection !== session;
  try {
    if (abandoned())
      return {
        status: "unavailable",
        reason: "Grouping was abandoned; created tab left unchanged",
      };
    if (
      typeof chrome.tabs.group !== "function" ||
      typeof chrome.tabGroups?.get !== "function" ||
      typeof chrome.tabGroups?.update !== "function"
    )
      return { status: "unavailable", reason: "Tab grouping is unavailable" };
    const current = await chrome.tabs.get(tab.id);
    if (
      abandoned() ||
      !session.owned.has(tab.id) ||
      session.removed.has(tab.id) ||
      !Number.isInteger(tab.windowId) ||
      current.windowId !== tab.windowId ||
      current.groupId !== -1
    )
      return {
        status: "unavailable",
        reason: "Tab or connection changed; grouping left unchanged",
      };
    let existingId = session.groups.get(JSON.stringify([taskId, tab.windowId]));
    if (existingId !== undefined) {
      try {
        const existing = await chrome.tabGroups.get(existingId);
        const members = await chrome.tabs.query({ groupId: existingId });
        if (
          existing.windowId !== tab.windowId ||
          !members.some((member) => session.owned.has(member.id))
        )
          existingId = undefined;
      } catch {
        existingId = undefined;
      }
      if (existingId === undefined)
        session.groups.delete(JSON.stringify([taskId, tab.windowId]));
    }
    // Recheck after asynchronous group lookup. Never reclaim a tab the user
    // moved or grouped, and never restore an older connection's visual group.
    const latest = await chrome.tabs.get(tab.id);
    if (
      abandoned() ||
      session.removed.has(tab.id) ||
      latest.windowId !== tab.windowId ||
      latest.groupId !== -1
    )
      return {
        status: "unavailable",
        reason: "Tab or connection changed; grouping left unchanged",
      };
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      ...(existingId === undefined
        ? { createProperties: { windowId: tab.windowId } }
        : { groupId: existingId }),
    });
    if (!Number.isSafeInteger(groupId) || groupId < 0)
      throw new Error("Browser returned an invalid tab group");
    if (abandoned()) return { status: "grouped", groupId };
    session.groups.set(JSON.stringify([taskId, tab.windowId]), groupId);
    if (existingId === undefined) {
      const created = await chrome.tabGroups.get(groupId);
      // Name only the fresh unnamed group. Reused/user-renamed groups are not
      // rewritten, nor do later tab updates trigger regrouping.
      if (!abandoned() && created.windowId === tab.windowId && !created.title)
        await chrome.tabGroups.update(groupId, {
          title: "ZenX",
          color: "blue",
        });
    }
    return { status: "grouped", groupId };
  } catch (error) {
    return {
      status:
        Number.isSafeInteger(groupId) && groupId >= 0 ? "grouped" : "failed",
      ...(Number.isSafeInteger(groupId) && groupId >= 0 ? { groupId } : {}),
      reason: describeError(error).slice(0, 160),
    };
  }
}

function disconnect(session) {
  if (session.closing !== undefined) return session.closing;
  if (connection === session) connection = undefined;
  session.rejectReady?.(new Error("Chrome disconnected"));
  session.port?.disconnect();
  session.closing = Promise.all(
    [...session.attachments.keys()].map((tabId) => detach(session, tabId)),
  ).then(async () => {
    if (connection !== undefined) return;
    await chrome.action.setBadgeText({ text: autoConnect ? "…" : "" });
    await chrome.action.setTitle({
      title: autoConnect
        ? "Waiting for ZenX; reconnecting automatically. Click to disconnect."
        : "Connect this browser to ZenX",
    });
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

// Random per-install identity only. No account or profile information is read.
async function browserIdentity() {
  const key = "zenxBrowserInstanceId";
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get(key);
  let instanceId = stored[key];
  if (
    typeof instanceId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instanceId)
  ) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ [key]: instanceId });
  }
  return {
    instanceId,
    browser: /\bEdg\//.test(navigator.userAgent) ? "edge" : "chrome",
  };
}
