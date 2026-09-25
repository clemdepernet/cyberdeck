// Whiteboard persistence: a dependency-free Node HTTP API storing one JSON file
// per board. The React app (built with Vite) is served by nginx; this only
// handles /whiteboard/api/boards.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const PORT = Number(process.env.PORT || 8102);
const MAX_BODY = 64 * 1024 * 1024; // boards can embed images
const ID_RE = /^[a-z0-9]{10}$/;

await fs.mkdir(DATA_DIR, { recursive: true });

const file = (id) => path.join(DATA_DIR, `${id}.json`);
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

async function listBoards() {
  const names = (await fs.readdir(DATA_DIR)).filter((n) => n.endsWith('.json'));
  const boards = [];
  for (const n of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, n), 'utf8'));
      boards.push({ id: raw.id, name: raw.name, updatedAt: raw.updatedAt, createdAt: raw.createdAt, elements: (raw.elements || []).length });
    } catch { /* skip corrupt file */ }
  }
  return boards.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function writeBoard(board) {
  const tmp = file(board.id) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(board));
  await fs.rename(tmp, file(board.id));
}

// The gate tags requests with X-Deck-Role: only the main account (or an open
// deck, which sends nothing) may delete.
const mayDelete = (req) => !['user', 'anon'].includes(req.headers['x-deck-role'] || '');

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.replace(/^\/whiteboard\/api\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'boards') return send(res, 404, { error: 'not found' });
  const id = parts[1];
  if (id && !ID_RE.test(id)) return send(res, 400, { error: 'invalid id' });

  try {
    if (req.method === 'GET' && !id) return send(res, 200, await listBoards());

    if (req.method === 'POST' && !id) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const now = new Date().toISOString();
      const board = {
        id: randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 10).padEnd(10, 'x'),
        name: String(body.name || 'Sans titre').slice(0, 120),
        createdAt: now, updatedAt: now,
        elements: body.elements || [], appState: body.appState || {}, files: body.files || {},
      };
      await writeBoard(board);
      return send(res, 201, { id: board.id, name: board.name, updatedAt: board.updatedAt });
    }

    if (req.method === 'GET' && id) {
      try { return send(res, 200, JSON.parse(await fs.readFile(file(id), 'utf8'))); }
      catch { return send(res, 404, { error: 'no board with this id' }); }
    }

    if (req.method === 'PUT' && id) {
      let existing;
      try { existing = JSON.parse(await fs.readFile(file(id), 'utf8')); }
      catch { return send(res, 404, { error: 'no board with this id' }); }
      const body = JSON.parse((await readBody(req)) || '{}');
      const board = {
        ...existing,
        name: body.name !== undefined ? String(body.name).slice(0, 120) : existing.name,
        elements: body.elements !== undefined ? body.elements : existing.elements,
        appState: body.appState !== undefined ? body.appState : existing.appState,
        files: body.files !== undefined ? body.files : existing.files,
        updatedAt: new Date().toISOString(),
      };
      await writeBoard(board);
      return send(res, 200, { id: board.id, name: board.name, updatedAt: board.updatedAt });
    }

    if (req.method === 'DELETE' && id) {
      if (!mayDelete(req)) return send(res, 403, { error: 'suppression réservée au compte principal' });
      try { await fs.unlink(file(id)); return send(res, 204, {}); }
      catch { return send(res, 404, { error: 'no board with this id' }); }
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, e.message === 'too large' ? 413 : 400, { error: e.message });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`whiteboard: listening on ${PORT}, boards in ${DATA_DIR}`));
}
