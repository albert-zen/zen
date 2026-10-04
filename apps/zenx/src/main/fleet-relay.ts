import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/** Trusted forwarding transport, not an authorization or conversation authority. */
export interface FleetRelayOptions {
  enabled: true;
  listen: string;
  port: number;
  tls: { cert: string | Buffer; key: string | Buffer };
  registrations: readonly { hostId: string; tokenSha256: string }[];
  /** Origin-bearing native clients must match this explicit HTTPS authority. */
  originEndpoint?: string;
  /** Bounded operation deadline; fixtures can shorten it without relaxing TLS. */
  operationTimeoutMs?: number;
}
export interface FleetRelayServer {
  endpoint: string;
  close(): Promise<void>;
}
export interface FleetRelayHostOptions {
  hostId: string;
  relayEndpoint: string;
  registrationToken: string;
  /** Fixed local native gateway; remote messages never supply a destination. */
  nativeEndpoint: string;
  ca?: string | Buffer;
  nativeCa?: string | Buffer;
  /** Validate this configured certificate identity while connecting to loopback. */
  nativeServerName?: string;
  operationTimeoutMs?: number;
}
export interface FleetRelayHost {
  /** Resolves on explicit close or tunnel failure. Never retries admitted work. */
  closed: Promise<void>;
  close(): Promise<void>;
}

const MAX_CONNECTIONS = 128;
const MAX_CLIENTS = 64;
const MAX_HOST_CLIENTS = 32;
const MAX_PENDING = 16;
const MAX_PAIR_BYTES = 2048;
const MAX_PAIR_RESPONSE_BYTES = 4096;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TUNNEL_BYTES = 3 * 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const HANDSHAKE_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u;
const TOKEN = /^[a-zA-Z0-9_-]{16,512}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function endpoint(value: string): URL {
  if (typeof value !== "string" || /[\s\\]/u.test(value))
    throw new Error("Fleet relay requires an explicit HTTPS authority");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error("Fleet relay requires an explicit HTTPS authority");
  return url;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value))
    throw new Error("Invalid Fleet relay identity");
  return value;
}
function timeout(value: number | undefined): number {
  if (value === undefined) return HANDSHAKE_MS;
  if (!Number.isInteger(value) || value < 100 || value > 10_000)
    throw new Error("Invalid Fleet relay operation timeout");
  return value;
}
/** Pre-provision only this digest at the relay; the Host keeps the secret. */
export function hashFleetRelayToken(value: string): string {
  if (!TOKEN.test(value))
    throw new Error("Invalid Fleet relay registration credential");
  return createHash("sha256").update(value).digest("hex");
}
function header(request: IncomingMessage, name: string): string | undefined {
  const count = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  ).length;
  const value = request.headers[name];
  return count === 1 && typeof value === "string" ? value : undefined;
}
function auth(value: unknown): value is string {
  return (
    typeof value === "string" && /^Bearer [a-zA-Z0-9_-]{1,512}$/u.test(value)
  );
}
function closeCode(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    ((value >= 1000 && value <= 1014 && ![1004, 1005, 1006].includes(value)) ||
      (value >= 3000 && value <= 4999))
  )
    return value;
  return 1011;
}
interface Envelope {
  type:
    "registered" | "pair" | "paired" | "open" | "opened" | "frame" | "close";
  id?: string;
  hostId?: string;
  deviceId?: string;
  authorization?: string;
  data?: string;
  status?: number;
  code?: number;
}
function parse(raw: Buffer, binary: boolean): Envelope {
  if (binary || raw.byteLength > MAX_TUNNEL_BYTES)
    throw new Error("Invalid Fleet relay frame");
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (
    !record(value) ||
    ![
      "registered",
      "pair",
      "paired",
      "open",
      "opened",
      "frame",
      "close",
    ].includes(String(value.type))
  )
    throw new Error("Invalid Fleet relay frame");
  const type = value.type as Envelope["type"];
  if (type === "registered") id(value.hostId);
  else id(value.id);
  if (
    ["pair", "paired", "frame"].includes(type) &&
    typeof value.data !== "string"
  )
    throw new Error("Invalid Fleet relay payload");
  if (
    type === "open" &&
    (!ID.test(String(value.deviceId)) || !auth(value.authorization))
  )
    throw new Error("Invalid Fleet relay client credentials");
  if (
    ["paired", "opened"].includes(type) &&
    ![200, 401, 403, 429, 502, 503, 504].includes(Number(value.status))
  )
    throw new Error("Invalid Fleet relay response status");
  return value as unknown as Envelope;
}
function decode(value: string | undefined, maximum: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  )
    throw new Error("Invalid Fleet relay payload");
  const result = Buffer.from(value, "base64");
  if (result.byteLength > maximum || result.toString("base64") !== value)
    throw new Error("Fleet relay payload limit");
  return result;
}
function send(socket: WebSocket, value: Envelope): boolean {
  const data = JSON.stringify(value);
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER_BYTES ||
    Buffer.byteLength(data) > MAX_TUNNEL_BYTES
  ) {
    socket.terminate();
    return false;
  }
  socket.send(data, (error) => {
    if (error) socket.terminate();
  });
  return true;
}
function sendNative(socket: WebSocket, data: Buffer): boolean {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + data.byteLength > MAX_BUFFER_BYTES
  ) {
    socket.terminate();
    return false;
  }
  socket.send(data, { binary: false }, (error) => {
    if (error) socket.terminate();
  });
  return true;
}
function heartbeat(socket: WebSocket): () => void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive || socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
function reply(
  response: ServerResponse,
  status: number,
  body: Buffer = Buffer.from('{"error":"relay_unavailable"}'),
) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(body);
}
function reject(socket: Duplex, status: number) {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
    );
}
interface PairPending {
  response: ServerResponse;
  timer: NodeJS.Timeout;
}
interface RemotePending {
  socket: Duplex;
  request: IncomingMessage;
  head: Buffer;
  timer: NodeJS.Timeout;
  client?: WebSocket;
}
interface RegisteredHost {
  socket: WebSocket;
  pairs: Map<string, PairPending>;
  remotes: Map<string, RemotePending>;
}

export async function serveFleetRelay(
  options: FleetRelayOptions,
): Promise<FleetRelayServer> {
  if (
    options.enabled !== true ||
    !options.listen ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    !options.tls.cert ||
    !options.tls.key ||
    !Array.isArray(options.registrations) ||
    options.registrations.length < 1 ||
    options.registrations.length > 64
  )
    throw new Error(
      "Fleet relay requires explicit TLS identity and registrations",
    );
  const operationMs = timeout(options.operationTimeoutMs);
  const origin =
    options.originEndpoint === undefined
      ? undefined
      : endpoint(options.originEndpoint).origin;
  const registrations = new Map<string, Buffer>();
  const digests = new Set<string>();
  for (const registration of options.registrations) {
    const hostId = id(registration.hostId);
    if (
      registrations.has(hostId) ||
      digests.has(registration.tokenSha256) ||
      !/^[a-f0-9]{64}$/u.test(registration.tokenSha256)
    )
      throw new Error("Invalid Fleet relay registration inventory");
    digests.add(registration.tokenSha256);
    registrations.set(hostId, Buffer.from(registration.tokenSha256, "hex"));
  }
  let closing = false,
    pending = 0,
    clients = 0;
  const hosts = new Map<string, RegisteredHost>();
  const rawSockets = new Set<Duplex>();
  const unauthenticated = new Map<Duplex, NodeJS.Timeout>();
  const releaseRaw = (socket: Duplex) => {
    const timer = unauthenticated.get(socket);
    if (timer) clearTimeout(timer);
    unauthenticated.delete(socket);
  };
  const acceptsOrigin = (req: IncomingMessage) => {
    if (
      !req.rawHeaders.some(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "origin",
      )
    )
      return true;
    return (
      origin !== undefined &&
      header(req, "origin") === origin &&
      header(req, "host") === new URL(origin).host
    );
  };
  const hostFor = (req: IncomingMessage) => {
    const hostId = header(req, "x-zen-host-id");
    return hostId && ID.test(hostId) ? hosts.get(hostId) : undefined;
  };
  const finishPair = (
    host: RegisteredHost,
    requestId: string,
    status?: number,
    body?: Buffer,
  ) => {
    const entry = host.pairs.get(requestId);
    if (!entry) return;
    host.pairs.delete(requestId);
    clearTimeout(entry.timer);
    pending--;
    if (status !== undefined) reply(entry.response, status, body);
  };
  const finishRemote = (
    host: RegisteredHost,
    requestId: string,
    code = 1011,
    status = 502,
    notify = true,
  ) => {
    const entry = host.remotes.get(requestId);
    if (!entry) return;
    host.remotes.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.client) {
      clients--;
      entry.client.close(closeCode(code), "Host connection closed");
    } else {
      pending--;
      reject(entry.socket, status);
    }
    if (notify)
      send(host.socket, {
        type: "close",
        id: requestId,
        code: closeCode(code),
      });
  };
  const clientServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REQUEST_BYTES,
    perMessageDeflate: false,
  });
  const tunnelServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TUNNEL_BYTES,
    perMessageDeflate: false,
  });
  const server = createServer(
    { ...options.tls, minVersion: "TLSv1.2", handshakeTimeout: HANDSHAKE_MS },
    (req, res) => {
      if (closing || req.method !== "POST" || req.url !== "/pair") {
        reply(res, closing ? 503 : 404);
        return;
      }
      if (
        !acceptsOrigin(req) ||
        req.headers.origin !== undefined ||
        header(req, "content-type") !== "application/json"
      ) {
        reply(res, 403);
        return;
      }
      const host = hostFor(req);
      if (!host) {
        reply(res, 503);
        return;
      }
      if (pending >= MAX_PENDING || host.pairs.size >= MAX_PENDING) {
        reply(res, 429);
        return;
      }
      const requestId = randomUUID();
      let bytes = 0;
      const chunks: Buffer[] = [];
      pending++;
      const timer = setTimeout(() => {
        finishPair(host, requestId, 504);
        req.destroy();
        send(host.socket, { type: "close", id: requestId });
      }, operationMs);
      host.pairs.set(requestId, { response: res, timer });
      res.once("close", () => {
        if (host.pairs.has(requestId)) {
          finishPair(host, requestId);
          send(host.socket, { type: "close", id: requestId });
        }
      });
      res.once("finish", () => releaseRaw(req.socket));
      req.on("error", () => finishPair(host, requestId));
      req.on("data", (part: Buffer) => {
        bytes += part.byteLength;
        if (bytes > MAX_PAIR_BYTES) {
          finishPair(host, requestId, 413);
          req.destroy();
        } else chunks.push(part);
      });
      req.on("end", () => {
        if (!host.pairs.has(requestId)) return;
        const body = Buffer.concat(chunks);
        try {
          const value: unknown = JSON.parse(body.toString());
          if (!record(value) || value.hostId !== header(req, "x-zen-host-id"))
            throw new Error("Invalid pair route");
          send(host.socket, {
            type: "pair",
            id: requestId,
            data: body.toString("base64"),
          });
        } catch {
          finishPair(host, requestId, 400);
        }
      });
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HANDSHAKE_MS;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => {
    if (closing || rawSockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
  });
  server.on("secureConnection", (socket) => {
    if (closing || unauthenticated.size >= MAX_PENDING) {
      socket.destroy();
      return;
    }
    unauthenticated.set(
      socket,
      setTimeout(() => socket.destroy(), 10_000),
    );
    socket.once("close", () => releaseRaw(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (closing || !acceptsOrigin(req)) {
      reject(socket, closing ? 503 : 403);
      return;
    }
    if (req.url === "/fleet/register") {
      const hostId = header(req, "x-zen-host-id"),
        credential = header(req, "authorization");
      const expected = hostId ? registrations.get(hostId) : undefined;
      if (
        req.headers.origin !== undefined ||
        !hostId ||
        !expected ||
        !credential?.startsWith("Bearer ") ||
        !TOKEN.test(credential.slice(7)) ||
        !timingSafeEqual(
          expected,
          createHash("sha256").update(credential.slice(7)).digest(),
        )
      ) {
        reject(socket, 401);
        return;
      }
      if (hosts.has(hostId)) {
        reject(socket, 409);
        return;
      }
      tunnelServer.handleUpgrade(req, socket, head, (ws) => {
        releaseRaw(req.socket);
        const host: RegisteredHost = {
          socket: ws,
          pairs: new Map(),
          remotes: new Map(),
        };
        hosts.set(hostId, host);
        const releaseHeartbeat = heartbeat(ws);
        ws.on("error", () => ws.terminate());
        ws.once("close", () => {
          releaseHeartbeat();
          if (hosts.get(hostId) === host) hosts.delete(hostId);
          for (const requestId of host.pairs.keys())
            finishPair(host, requestId, 502);
          for (const requestId of host.remotes.keys())
            finishRemote(host, requestId, 1011, 502, false);
        });
        ws.on("message", (raw, binary) => {
          try {
            const value = parse(Buffer.from(raw as Buffer), binary),
              requestId = value.id!;
            switch (value.type) {
              case "paired": {
                const entry = host.pairs.get(requestId);
                if (!entry) return;
                const body = decode(value.data, MAX_PAIR_RESPONSE_BYTES);
                finishPair(host, requestId, value.status, body);
                break;
              }
              case "opened": {
                const entry = host.remotes.get(requestId);
                if (!entry || entry.client) return;
                if (value.status !== 200) {
                  finishRemote(host, requestId, 1011, value.status);
                  return;
                }
                if (entry.socket.destroyed) {
                  finishRemote(host, requestId);
                  return;
                }
                if (clients >= MAX_CLIENTS) {
                  finishRemote(host, requestId, 1013, 429);
                  return;
                }
                clearTimeout(entry.timer);
                clientServer.handleUpgrade(
                  entry.request,
                  entry.socket,
                  entry.head,
                  (client) => {
                    releaseRaw(entry.request.socket);
                    pending--;
                    clients++;
                    entry.client = client;
                    client.on("error", () => client.terminate());
                    client.on("message", (data, binary) => {
                      if (
                        binary ||
                        Buffer.byteLength(data as Buffer) > MAX_REQUEST_BYTES
                      ) {
                        finishRemote(host, requestId, 1003);
                        return;
                      }
                      send(ws, {
                        type: "frame",
                        id: requestId,
                        data: Buffer.from(data as Buffer).toString("base64"),
                      });
                    });
                    client.once("close", (code) =>
                      finishRemote(host, requestId, code),
                    );
                  },
                );
                break;
              }
              case "frame": {
                const entry = host.remotes.get(requestId);
                if (!entry) return;
                if (!entry.client) throw new Error("Frame before admission");
                sendNative(
                  entry.client,
                  decode(value.data, MAX_RESPONSE_BYTES),
                );
                break;
              }
              case "close":
                finishRemote(
                  host,
                  requestId,
                  closeCode(value.code),
                  502,
                  false,
                );
                break;
              default:
                throw new Error("Unexpected Fleet relay message");
            }
          } catch {
            ws.terminate();
          }
        });
        send(ws, { type: "registered", hostId });
      });
      return;
    }
    if (req.url !== "/remote") {
      reject(socket, 404);
      return;
    }
    const host = hostFor(req),
      deviceId = header(req, "x-zen-device-id"),
      authorization = header(req, "authorization");
    if (!host) {
      reject(socket, 503);
      return;
    }
    if (!deviceId || !ID.test(deviceId) || !auth(authorization)) {
      reject(socket, 401);
      return;
    }
    if (
      pending >= MAX_PENDING ||
      clients >= MAX_CLIENTS ||
      host.remotes.size >= MAX_HOST_CLIENTS
    ) {
      reject(socket, 429);
      return;
    }
    const requestId = randomUUID();
    pending++;
    const timer = setTimeout(
      () => finishRemote(host, requestId, 1011, 504),
      operationMs,
    );
    host.remotes.set(requestId, { socket, request: req, head, timer });
    socket.once("close", () => finishRemote(host, requestId));
    send(host.socket, { type: "open", id: requestId, deviceId, authorization });
  });
  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, options.listen, () => {
        server.off("error", rejectListen);
        resolve();
      });
    });
  } catch (error) {
    tunnelServer.close();
    clientServer.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const hostname = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  let closePromise: Promise<void> | undefined;
  return {
    endpoint: `https://${hostname}:${address.port}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
      for (const host of hosts.values()) host.socket.terminate();
      for (const socket of rawSockets) socket.destroy();
      server.closeAllConnections();
      tunnelServer.close();
      clientServer.close();
      return closePromise;
    },
  };
}

/** One outbound reverse tunnel. Failure closes dependent streams without replay. */
export async function connectFleetRelayHost(
  options: FleetRelayHostOptions,
): Promise<FleetRelayHost> {
  const hostId = id(options.hostId),
    relay = endpoint(options.relayEndpoint),
    native = endpoint(options.nativeEndpoint);
  hashFleetRelayToken(options.registrationToken);
  const operationMs = timeout(options.operationTimeoutMs);
  if (
    options.nativeServerName !== undefined &&
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/u.test(
      options.nativeServerName,
    )
  )
    throw new Error("Invalid Fleet relay native TLS identity");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(native.hostname))
    throw new Error(
      "Fleet relay bridge requires a fixed loopback native gateway",
    );
  const nativeServerName =
    options.nativeServerName ??
    (native.hostname === "localhost" ? "localhost" : undefined);
  if (native.hostname === "localhost") native.hostname = "127.0.0.1";
  const registration = new URL("/fleet/register", relay);
  registration.protocol = "wss:";
  const tunnel = new WebSocket(registration, {
    headers: {
      "x-zen-host-id": hostId,
      authorization: `Bearer ${options.registrationToken}`,
    },
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    handshakeTimeout: operationMs,
    maxPayload: MAX_TUNNEL_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  });
  const remotes = new Map<string, WebSocket>();
  const pairs = new Map<string, ReturnType<typeof httpsRequest>>();
  let resolveClosed!: () => void,
    closed = false,
    registered = false;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let releaseHeartbeat = () => {};
  const shutdown = () => {
    if (closed) return;
    closed = true;
    releaseHeartbeat();
    for (const request of pairs.values()) request.destroy();
    pairs.clear();
    for (const socket of remotes.values()) socket.terminate();
    remotes.clear();
    tunnel.terminate();
    resolveClosed();
  };
  const tls = {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2" as const,
    ...(options.nativeCa === undefined ? {} : { ca: options.nativeCa }),
    ...(nativeServerName === undefined ? {} : { servername: nativeServerName }),
  };
  let resolveStart!: () => void, rejectStart!: (error: Error) => void;
  const start = new Promise<void>((resolve, rejectConnect) => {
    resolveStart = resolve;
    rejectStart = rejectConnect;
  });
  const startTimer = setTimeout(() => {
    rejectStart(new Error("Fleet relay registration timed out"));
    shutdown();
  }, operationMs);
  tunnel.once("open", () => {
    releaseHeartbeat = heartbeat(tunnel);
  });
  tunnel.on("error", () => {
    rejectStart(
      new Error(
        "Fleet relay TLS registration failed. Check the trusted identity and registration credential.",
      ),
    );
    shutdown();
  });
  tunnel.once("close", () => {
    rejectStart(new Error("Fleet relay registration rejected or disconnected"));
    shutdown();
  });
  tunnel.on("message", (raw, binary) => {
    try {
      const value = parse(Buffer.from(raw as Buffer), binary);
      if (!registered) {
        if (value.type !== "registered" || value.hostId !== hostId)
          throw new Error("Fleet relay registration identity mismatch");
        registered = true;
        clearTimeout(startTimer);
        resolveStart();
        return;
      }
      const requestId = value.id!;
      switch (value.type) {
        case "pair": {
          if (
            pairs.has(requestId) ||
            remotes.has(requestId) ||
            pairs.size >= MAX_PENDING
          )
            throw new Error("Invalid Fleet relay pair admission");
          const body = decode(value.data, MAX_PAIR_BYTES),
            data: unknown = JSON.parse(body.toString());
          if (!record(data) || data.hostId !== hostId)
            throw new Error("Fleet relay pair Host mismatch");
          let done = false;
          const finish = (
            status: number,
            response: Buffer = Buffer.from('{"error":"relay_unavailable"}'),
          ) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            pairs.delete(requestId);
            send(tunnel, {
              type: "paired",
              id: requestId,
              status,
              data: response.toString("base64"),
            });
          };
          const request = httpsRequest(
            new URL("/pair", native),
            {
              ...tls,
              method: "POST",
              headers: {
                "content-type": "application/json",
                "content-length": body.byteLength,
              },
              agent: false,
            },
            (response) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("data", (part: Buffer) => {
                bytes += part.byteLength;
                if (bytes > MAX_PAIR_RESPONSE_BYTES) {
                  finish(502);
                  request.destroy();
                } else chunks.push(part);
              });
              response.on("error", () => finish(502));
              response.on("end", () => {
                const result = Buffer.concat(chunks);
                try {
                  const parsed: unknown = JSON.parse(result.toString());
                  if (
                    !record(parsed) ||
                    (response.statusCode === 200 &&
                      (parsed.hostId !== hostId ||
                        parsed.deviceId !== data.deviceId))
                  )
                    throw new Error("Invalid native pair identity");
                  finish(
                    response.statusCode === 200
                      ? 200
                      : response.statusCode === 401
                        ? 401
                        : 502,
                    result,
                  );
                } catch {
                  finish(502);
                }
              });
            },
          );
          const timer = setTimeout(() => {
            finish(504);
            request.destroy();
          }, operationMs);
          pairs.set(requestId, request);
          request.on("error", () => finish(502));
          request.end(body);
          break;
        }
        case "open": {
          if (pairs.has(requestId) || remotes.has(requestId))
            throw new Error("Invalid Fleet relay remote admission");
          if (remotes.size >= MAX_HOST_CLIENTS) {
            send(tunnel, { type: "opened", id: requestId, status: 503 });
            break;
          }
          const url = new URL("/remote", native);
          url.protocol = "wss:";
          const remote = new WebSocket(url, {
            ...tls,
            headers: {
              "x-zen-device-id": value.deviceId!,
              authorization: value.authorization!,
            },
            handshakeTimeout: operationMs,
            maxPayload: MAX_RESPONSE_BYTES,
            perMessageDeflate: false,
            followRedirects: false,
          });
          remotes.set(requestId, remote);
          let opened = false;
          remote.once("open", () => {
            opened = true;
            send(tunnel, { type: "opened", id: requestId, status: 200 });
          });
          remote.on("message", (data, isBinary) => {
            if (isBinary) {
              remote.close(1003, "JSON text only");
              return;
            }
            send(tunnel, {
              type: "frame",
              id: requestId,
              data: Buffer.from(data as Buffer).toString("base64"),
            });
          });
          remote.once("unexpected-response", (_request, response) => {
            send(tunnel, {
              type: "opened",
              id: requestId,
              status:
                response.statusCode === 401
                  ? 401
                  : response.statusCode === 403
                    ? 403
                    : 502,
            });
            response.destroy();
            remote.terminate();
          });
          remote.on("error", () => {
            if (!opened)
              send(tunnel, { type: "opened", id: requestId, status: 502 });
            remote.terminate();
          });
          remote.once("close", (code) => {
            remotes.delete(requestId);
            send(tunnel, {
              type: "close",
              id: requestId,
              code: closeCode(code),
            });
          });
          break;
        }
        case "frame": {
          const remote = remotes.get(requestId);
          if (!remote) return;
          sendNative(remote, decode(value.data, MAX_REQUEST_BYTES));
          break;
        }
        case "close": {
          const request = pairs.get(requestId);
          if (request) {
            pairs.delete(requestId);
            request.destroy();
          }
          const remote = remotes.get(requestId);
          if (remote) {
            // The downstream client is already gone. Release capacity now rather
            // than waiting for a native peer's close handshake.
            remotes.delete(requestId);
            remote.terminate();
          }
          break;
        }
        default:
          throw new Error("Unexpected Fleet relay message");
      }
    } catch {
      rejectStart(new Error("Invalid Fleet relay registration protocol"));
      shutdown();
    }
  });
  try {
    await start;
  } catch (error) {
    clearTimeout(startTimer);
    shutdown();
    throw error;
  }
  return {
    closed: closedPromise,
    async close() {
      shutdown();
      await closedPromise;
    },
  };
}
