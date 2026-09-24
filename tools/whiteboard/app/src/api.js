const base = '/whiteboard/api/boards';

async function call(url, init) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (r.status === 204) return null;
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

export const listBoards = () => call(base);
export const getBoard = (id) => call(`${base}/${id}`);
export const createBoard = (data) => call(base, { method: 'POST', body: JSON.stringify(data) });
export const updateBoard = (id, data) => call(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteBoard = (id) => call(`${base}/${id}`, { method: 'DELETE' });
