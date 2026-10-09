// VERNACULAR_SAFETY_017 language harness — zero-dep dev server.
//
// Serves test/language-harness/index.html at / and proxies /api/* to the
// local backend (default 127.0.0.1:3000) with two fixups proven against
// local better-auth:
//   - Origin rewritten to http://localhost:3000 (a trusted origin), so
//     preflight/session checks pass from the http://localhost:5050 page.
//   - set-cookie relaxed for the http origin: drop `; Secure` and
//     `; Domain=`, rewrite `; SameSite=None` → `; SameSite=Lax`.
//
// Read-only for the repo; holds no secrets. The page mirrors the app
// contract under test: it NEVER sends a `language` field on messages
// (LANG_ID_016 — detection from the message text is the sole input).
//
// Run:  node test/language-harness/server.mjs
// Env:  HARNESS_PORT (default 5050), UPSTREAM_HOST/PORT (default 127.0.0.1:3000)

import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HARNESS_PORT ?? 5050);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3000);
const INDEX = join(HERE, 'index.html');

function fixSetCookie(value) {
  return value
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*SameSite=None/gi, '; SameSite=Lax');
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url === '/' || url === '/index.html') {
    try {
      const html = await readFile(INDEX);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('index.html missing next to server.mjs');
    }
    return;
  }

  if (!url.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found (only / and /api/* are served)');
    return;
  }

  const headers = { ...req.headers };
  delete headers.connection;
  headers.host = `localhost:${UPSTREAM_PORT}`;
  headers.origin = `http://localhost:${UPSTREAM_PORT}`;

  const upstream = httpRequest(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: url,
      headers,
    },
    (up) => {
      const out = { ...up.headers };
      if (out['set-cookie']) {
        out['set-cookie'] = out['set-cookie'].map(fixSetCookie);
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error(`[harness] upstream error: ${err.message}`);
    if (res.headersSent) {
      // A killed upstream mid-stream would otherwise crash with
      // ERR_HTTP_HEADERS_SENT.
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `backend unreachable on ${UPSTREAM_HOST}:${UPSTREAM_PORT} — is it running?`,
      }),
    );
  });

  req.pipe(upstream);
});

server.listen(PORT, () => {
  console.log(`language harness:  http://localhost:${PORT}`);
  console.log(
    `proxying /api/* →  http://${UPSTREAM_HOST}:${UPSTREAM_PORT} (Origin → localhost:${UPSTREAM_PORT})`,
  );
});
