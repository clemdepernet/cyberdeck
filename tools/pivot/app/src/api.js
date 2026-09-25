const base = '/pivot/api/maps';

async function call(url, init) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (r.status === 204) return null;
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

export const listMaps = () => call(base);
export const getMap = (id) => call(`${base}/${id}`);
export const createMap = (data) => call(base, { method: 'POST', body: JSON.stringify(data) });
export const updateMap = (id, data) => call(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteMap = (id) => call(`${base}/${id}`, { method: 'DELETE' });
