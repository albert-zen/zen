import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';

export type DesktopStaticHost = {
  readonly url: string;
  quiesce(): Promise<void>;
  close(): Promise<void>;
};

export type DesktopStaticHostOptions = {
  readonly apiTarget: string | URL;
  readonly capability: string;
  readonly host?: string;
  readonly port?: number;
  readonly staticRoot: string;
};

export type StaticRequestResolution =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'fallback'; readonly path: string }
  | { readonly type: 'forbidden' }
  | { readonly type: 'not-found' };

const API_PATHS = new Set(['/request', '/events']);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

export async function serveDesktopStaticHost(
  options: DesktopStaticHostOptions
): Promise<DesktopStaticHost> {
  const staticRoot = resolve(options.staticRoot);
  const apiTarget = new URL(options.apiTarget);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  let accepting = true;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    void handleRequest(request, response).catch((cause: unknown) => {
      if (!response.headersSent) send(response, 500, 'Internal server error');
      response.destroy(cause instanceof Error ? cause : new Error(String(cause)));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    if (!accepting) {
      send(response, 503, 'Desktop host is shutting down');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    if (API_PATHS.has(url.pathname)) {
      proxyAgentAppRequest(request, response, apiTarget, options.capability);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed');
      return;
    }
    const resolution = resolveStaticRequest(staticRoot, url.pathname);
    if (resolution.type === 'forbidden') {
      send(response, 403, 'Forbidden');
      return;
    }
    if (resolution.type === 'not-found') {
      send(response, 404, 'Not found');
      return;
    }
    serveFile(response, resolution.path, request.method === 'HEAD');
  };

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(port, host, () => {
      server.off('error', rejectListening);
      resolveListening();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.address}:${address.port}`,
    quiesce: async () => {
      accepting = false;
    },
    close: () => {
      closePromise ??= (async () => {
        accepting = false;
        for (const response of responses) response.end();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((cause) => (cause ? rejectClose(cause) : resolveClose()));
        });
      })();
      return closePromise;
    },
  };
}

export function resolveStaticRequest(root: string, pathname: string): StaticRequestResolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { type: 'forbidden' };
  }
  if (decoded.includes('\0')) return { type: 'forbidden' };
  const candidate = resolve(root, `.${decoded.replaceAll('/', sep)}`);
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    return { type: 'forbidden' };
  }
  if (existsSync(candidate) && statSync(candidate).isFile())
    return { type: 'file', path: candidate };
  if (extname(decoded)) return { type: 'not-found' };
  const index = resolve(root, 'index.html');
  return existsSync(index) ? { type: 'fallback', path: index } : { type: 'not-found' };
}

function proxyAgentAppRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  target: URL,
  capability: string
): void {
  const request = requestHttp(
    target,
    {
      method: incoming.method,
      path: incoming.url,
      headers: {
        ...incoming.headers,
        authorization: `Bearer ${capability}`,
        host: target.host,
      },
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
  );
  request.once('error', () => {
    if (!outgoing.headersSent) send(outgoing, 502, 'Agent App transport unavailable');
  });
  outgoing.once('close', () => request.destroy());
  incoming.pipe(request);
}

function serveFile(response: ServerResponse, path: string, head: boolean): void {
  response.writeHead(200, {
    'cache-control': path.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': mimeType(path),
    'x-content-type-options': 'nosniff',
  });
  if (head) {
    response.end();
    return;
  }
  createReadStream(path)
    .once('error', () => response.destroy())
    .pipe(response);
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
