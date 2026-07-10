import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrotliCompress, createGzip } from 'node:zlib';
import { decodeStaticRequestPath } from './static-web-routing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) {
    return match.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const root = path.resolve(process.cwd(), readArg('root', path.join(__dirname, '../../dist')));
const port = Number(readArg('port', process.env.PORT ?? '8081'));
const host = readArg('host', process.env.HOST ?? '127.0.0.1');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);
const compressibleExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.wasm']);

function acceptedEncoding(request, extension) {
  if (!compressibleExtensions.has(extension)) return null;
  const value = request.headers['accept-encoding'] ?? '';
  if (/\bbr\b/.test(value)) return 'br';
  if (/\bgzip\b/.test(value)) return 'gzip';
  return null;
}

function insideRoot(filePath) {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingFile(filePath) {
  if (!filePath || !insideRoot(filePath) || !existsSync(filePath)) {
    return null;
  }
  const stats = statSync(filePath);
  if (stats.isFile()) {
    return filePath;
  }
  if (stats.isDirectory()) {
    return existingFile(path.join(filePath, 'index.html'));
  }
  return null;
}

// Match a path segment against an expo-router dynamic-route template file
// (`[id].html`, `[...rest].html`) in the directory where the literal file would
// live, so deep-linking `/player/<uuid>` serves `player/[id].html` — the correct
// template — instead of falling back to the root index.html (which mounts blank).
function dynamicTemplate(routePath) {
  const segments = routePath.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const parentDir = path.join(root, ...segments.slice(0, -1));
  if (!insideRoot(parentDir) || !existsSync(parentDir)) return null;
  let entries;
  try {
    entries = readdirSync(parentDir);
  } catch {
    return null;
  }
  const single = entries.find((e) => /^\[[^.[\]]+\]\.html$/.test(e));
  if (single) return path.join(parentDir, single);
  const rest = entries.find((e) => /^\[\.\.\.[^[\]]+\]\.html$/.test(e));
  if (rest) return path.join(parentDir, rest);
  return null;
}

function resolveRoute(decodedPath) {
  const normalized = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const stripped = normalized.replace(/^[/\\]+/, '');
  const withoutSlash = stripped === '' ? 'index' : stripped.replace(/[/\\]$/, '');

  return (
    existingFile(path.join(root, stripped)) ??
    existingFile(path.join(root, `${withoutSlash}.html`)) ??
    existingFile(path.join(root, withoutSlash, 'index.html')) ??
    existingFile(dynamicTemplate(withoutSlash)) ??
    // Unmatched routes fall back to the not-found prerender (mirrors
    // vercel.json), so the served markup matches the client-rendered
    // not-found screen — no React hydration mismatch. index.html is a
    // last resort if the not-found prerender is somehow absent.
    existingFile(path.join(root, '+not-found.html')) ??
    existingFile(path.join(root, 'index.html'))
  );
}

if (!existsSync(root)) {
  console.error(`Static root does not exist: ${root}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const decoded = decodeStaticRequestPath(requestUrl.pathname);
  if (!decoded.ok) {
    response.writeHead(decoded.status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(decoded.message);
    return;
  }
  const filePath = resolveRoute(decoded.path);
  if (!filePath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const extension = path.extname(filePath);
  const immutableAsset = filePath.includes(`${path.sep}_expo${path.sep}static${path.sep}`);
  const encoding = acceptedEncoding(request, extension);
  response.writeHead(200, {
    'cache-control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store',
    'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
    ...(encoding ? { 'content-encoding': encoding, vary: 'Accept-Encoding' } : {}),
  });
  const source = createReadStream(filePath);
  if (encoding === 'br') source.pipe(createBrotliCompress()).pipe(response);
  else if (encoding === 'gzip') source.pipe(createGzip()).pipe(response);
  else source.pipe(response);
});

server.listen(port, host, () => {
  console.log(`Static E2E web server listening at http://${host}:${port}`);
  console.log(`Serving ${root}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
