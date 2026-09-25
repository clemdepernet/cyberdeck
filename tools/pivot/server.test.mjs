import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'pivot-'));
const { handle } = await import('./server.mjs');
const server = createServer(handle).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/pivot/api/maps`;
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: r.status === 204 ? null : await r.json() }; };

test('map lifecycle', async () => {
  const created = await json(base, { method: 'POST', body: JSON.stringify({ name: 'Client X', nodes: [{ id: 'h1' }], edges: [] }) });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const list = await json(base);
  assert.equal(list.body[0].nodes, 1);
  const put = await json(`${base}/${id}`, { method: 'PUT', body: JSON.stringify({ edges: [{ id: 'e1' }], name: 'Client X v2' }) });
  assert.equal(put.status, 200);
  const got = await json(`${base}/${id}`);
  assert.equal(got.body.name, 'Client X v2');
  assert.equal(got.body.edges.length, 1);
  assert.equal(got.body.nodes.length, 1);
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await json(`${base}/${id}`)).status, 404);
  assert.equal((await json(`${base}/not-valid`)).status, 400);
});

test.after(() => server.close());

test('other accounts cannot delete', async () => {
  const created = await json(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
  const id = created.body.id;
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'user' } })).status, 403);
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'anon' } })).status, 403);
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'admin' } })).status, 204);
});
