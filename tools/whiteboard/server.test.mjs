import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'wb-'));
const { handle } = await import('./server.mjs');
const server = createServer(handle).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/whiteboard/api/boards`;
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: r.status === 204 ? null : await r.json() }; };

test('board lifecycle', async () => {
  const created = await json(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Archi cible', elements: [{ id: 'a' }] }) });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.match(id, /^[a-z0-9]{10}$/);

  const list = await json(base);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].elements, 1);

  const put = await json(`${base}/${id}`, { method: 'PUT', body: JSON.stringify({ elements: [{ id: 'a' }, { id: 'b' }], name: 'Archi v2' }) });
  assert.equal(put.status, 200);
  const got = await json(`${base}/${id}`);
  assert.equal(got.body.name, 'Archi v2');
  assert.equal(got.body.elements.length, 2);

  assert.equal((await json(`${base}/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await json(`${base}/${id}`)).status, 404);
  assert.equal((await json(`${base}/not-a-valid-id`)).status, 400);
});

test.after(() => server.close());

test('other accounts cannot delete', async () => {
  const created = await json(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
  const id = created.body.id;
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'user' } })).status, 403);
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'anon' } })).status, 403);
  assert.equal((await json(`${base}/${id}`, { method: 'DELETE', headers: { 'x-deck-role': 'admin' } })).status, 204);
});
