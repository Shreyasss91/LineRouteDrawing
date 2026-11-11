/**
 * Minimal static file server for local use.
 *
 * Deliberately dependency-free: a plain `file://` open cannot load ES modules
 * reliably in every browser, so this serves the project directory over HTTP on
 * localhost. No network access beyond the loopback interface, no build step.
 *
 * Usage: node scripts/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a request path inside ROOT, refusing traversal outside it. */
function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = normalize(join(ROOT, relative));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  const target = resolveRequestPath(request.url ?? '/');
  if (!target) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    const filePath = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Line Route Drawing Generator: http://127.0.0.1:${PORT}/\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');
});
