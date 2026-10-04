// Local device labels/addresses only. Credentials stay in the transport's secure store.
export const FLEET_ADDRESSES_KEY = "zenx-mobile-addresses-v1";
export const FLEET_PREFERENCE_KEY = "zenx-mobile-host-preference-v1";
export const MAX_REMOTE_HOSTS = 10;

export function hostEndpoint(value) {
  if (typeof value !== "string")
    throw Error("Enter the device's HTTPS origin.");
  const endpoint = value.trim();
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw Error("Enter an HTTPS origin, such as https://desktop.example:443.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /\s/u.test(endpoint) ||
    !endpoint.startsWith("https://") ||
    endpoint.includes("\\")
  )
    throw Error(
      "Use only an HTTPS origin, without credentials, a path or query.",
    );
  // Preserve a saved spelling: a grant is bound to the exact configured origin.
  return endpoint;
}

export function makeHost({ id, endpoint, name }) {
  const hostId = typeof id === "string" ? id.trim() : "";
  if (!/^[a-zA-Z0-9-]{8,80}$/u.test(hostId))
    throw Error(
      "Enter the Host ID shown on the device's Fleet hosting screen.",
    );
  const label = typeof name === "string" ? name.trim() : "";
  if (label.length > 80)
    throw Error("Device names must be 80 characters or fewer.");
  return {
    id: hostId,
    endpoint: hostEndpoint(endpoint),
    name: label || hostId,
  };
}

export function readSavedHosts(saved, reservedIds = []) {
  if (!saved) return [];
  const entries = JSON.parse(saved);
  if (!Array.isArray(entries))
    throw Error("Saved Fleet addresses are invalid.");
  const ids = new Set(reservedIds);
  const hosts = [];
  for (const entry of entries) {
    try {
      const host = makeHost(entry ?? {});
      if (ids.has(host.id)) continue;
      ids.add(host.id);
      hosts.push(host);
      if (hosts.length === MAX_REMOTE_HOSTS) break;
    } catch {
      // A malformed record never gains authority or falls back to demo data.
    }
  }
  return hosts;
}

export function saveHosts(hosts, fixtureIds = []) {
  return JSON.stringify(
    hosts.filter((host) => !fixtureIds.includes(host.id)).map(makeHost),
  );
}

export function deviceStatus({ fixture, selected, connection, pairing }) {
  if (fixture) return selected ? "Demo fixture · selected" : "Demo fixture";
  if (selected && connection === "pairing") return "Pairing…";
  if (selected && connection === "connecting") return "Connecting…";
  if (selected && connection === "connected")
    return "Connected · verified Host";
  if (pairing === "revoked") return "Pairing revoked · pair again";
  if (pairing === "unpaired") return "Not paired";
  if (pairing === "invalid") return "Saved pairing invalid · pair again";
  if (selected && connection === "offline")
    return "Disconnected · reconnect to check";
  if (pairing === "paired") return "Paired · disconnected";
  return "Checking saved pairing…";
}

export function reconnectAvailable({ host, connection, command, pairing }) {
  return (
    !!host &&
    pairing === "paired" &&
    (connection === "offline" || command === "uncertain")
  );
}
