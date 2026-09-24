// Pivot persistence: one JSON file per map under DATA_DIR, no dependencies.
// The React app is served by nginx; this only answers /pivot/api/maps.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const PORT = Number(process.env.PORT || 8105);
const MAX_BODY = 64 * 1024 * 1024;
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
const newId = () => randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 10).padEnd(10, 'x');

async function list() {
  const names = (await fs.readdir(DATA_DIR)).filter((n) => n.endsWith('.json'));
  const maps = [];
  for (const n of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, n), 'utf8'));
      maps.push({ id: raw.id, name: raw.name, updatedAt: raw.updatedAt, createdAt: raw.createdAt, nodes: (raw.nodes || []).length, edges: (raw.edges || []).length });
    } catch { /* skip corrupt file */ }
  }
  return maps.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function write(map) {
  const tmp = file(map.id) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(map));
  await fs.rename(tmp, file(map.id));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.replace(/^\/pivot\/api\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'maps') return send(res, 404, { error: 'not found' });
  const id = parts[1];
  if (id && !ID_RE.test(id)) return send(res, 400, { error: 'invalid id' });
  try {
    if (req.method === 'GET' && !id) return send(res, 200, await list());
    if (req.method === 'POST' && !id) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const now = new Date().toISOString();
      const map = { id: newId(), name: String(body.name || 'Sans titre').slice(0, 120), createdAt: now, updatedAt: now,
        nodes: body.nodes || [], edges: body.edges || [], viewport: body.viewport || null };
      await write(map);
      return send(res, 201, { id: map.id, name: map.name, updatedAt: map.updatedAt });
    }
    if (req.method === 'GET' && id) {
      try { return send(res, 200, JSON.parse(await fs.readFile(file(id), 'utf8'))); }
      catch { return send(res, 404, { error: 'no map with this id' }); }
    }
    if (req.method === 'PUT' && id) {
      let existing;
      try { existing = JSON.parse(await fs.readFile(file(id), 'utf8')); }
      catch { return send(res, 404, { error: 'no map with this id' }); }
      const body = JSON.parse((await readBody(req)) || '{}');
      const map = { ...existing,
        name: body.name !== undefined ? String(body.name).slice(0, 120) : existing.name,
        nodes: body.nodes !== undefined ? body.nodes : existing.nodes,
        edges: body.edges !== undefined ? body.edges : existing.edges,
        viewport: body.viewport !== undefined ? body.viewport : existing.viewport,
        updatedAt: new Date().toISOString() };
      await write(map);
      return send(res, 200, { id: map.id, name: map.name, updatedAt: map.updatedAt });
    }
    if (req.method === 'DELETE' && id) {
      try { await fs.unlink(file(id)); return send(res, 204, {}); }
      catch { return send(res, 404, { error: 'no map with this id' }); }
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, e.message === 'too large' ? 413 : 400, { error: e.message });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`pivot: listening on ${PORT}, maps in ${DATA_DIR}`));
}
