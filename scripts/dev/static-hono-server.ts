import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createHonoApp, type ApiRouteMode } from '@stark-ballot/api/server';

const DEFAULT_PORT = 3000;
const DIST_DIR = resolve(process.cwd(), 'dist');
export const STATIC_API_ROUTE_MODE: ApiRouteMode = 'lambda';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getPort(): number {
  const parsed = Number.parseInt(process.env['PORT'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `localhost:${getPort()}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }
    if (typeof value === 'string') {
      headers.set(key, value);
    }
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  } as RequestInit & { duplex?: 'half' });
}

function sendFetchResponse(response: Response, res: ServerResponse): void {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.pipe(res);
}

function resolveStaticPath(pathname: string, distDir = DIST_DIR): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded.replace(/^\/+/, ''));
  if (relative.startsWith('..') || relative.includes(`${sep}..${sep}`)) {
    return null;
  }
  return join(distDir, relative);
}

function sendFile(filePath: string, res: ServerResponse): void {
  const ext = extname(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  createReadStream(filePath).pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, distDir = DIST_DIR): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const staticPath = resolveStaticPath(url.pathname, distDir);
  if (staticPath && existsSync(staticPath) && statSync(staticPath).isFile()) {
    sendFile(staticPath, res);
    return;
  }

  const hasFileExtension = extname(url.pathname).length > 0;
  const indexHtml = join(distDir, 'index.html');
  if (hasFileExtension || !existsSync(indexHtml)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }

  sendFile(indexHtml, res);
}

export function isApiRequestPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function createStaticHonoServer(distDir = DIST_DIR): Server {
  const honoApp = createHonoApp({ basePath: '/api', mode: STATIC_API_ROUTE_MODE });
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (isApiRequestPath(url.pathname)) {
      void Promise.resolve(honoApp.fetch(toRequest(req))).then(
        (response: Response) => {
          sendFetchResponse(response, res);
        },
        (error: unknown) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(error instanceof Error ? error.message : 'Internal server error');
        },
      );
      return;
    }
    serveStatic(req, res, distDir);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = getPort();
  createStaticHonoServer().listen(port, () => {
    console.log(`[static-hono] serving ${DIST_DIR} with Hono API on http://localhost:${port}`);
  });
}
