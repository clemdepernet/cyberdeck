// Turns parsed scanner records ({hosts, paths}) into nodes and edges, merging
// into what the map already holds: a host seen twice keeps one node and the
// union of its ports; a web app is one node per base URL, linked to its host.
import { KINDS } from './nodes.jsx';

let seq = 0;
export const newId = (prefix = 'n') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

const GAP_X = 260, GAP_Y = 40, COLS = 4;

function hostKey(ip, hostname) { return (ip || hostname || '').toLowerCase(); }

function hostOf(url) {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

function mergePorts(existing, incoming) {
  const out = [...existing];
  for (const p of incoming) {
    const i = out.findIndex((q) => Number(q.port) === Number(p.port) && (q.proto || 'tcp') === (p.proto || 'tcp'));
    if (i === -1) out.push({ ...p });
    else out[i] = { ...out[i], service: out[i].service || p.service, version: out[i].version || p.version };
  }
  return out.sort((a, b) => Number(a.port) - Number(b.port));
}

function mergePaths(existing, incoming) {
  const out = [...existing];
  for (const p of incoming) if (!out.some((q) => q.path === p.path)) out.push({ path: p.path, status: p.status, size: p.size });
  return out;
}

export function importRecords(parsed, nodes, edges, opts = {}) {
  const { servicesAsNodes = false } = opts;
  const nextNodes = nodes.map((n) => ({ ...n, data: { ...n.data } }));
  const nextEdges = [...edges];
  const created = [];
  let placed = 0;

  // Where to drop new things: below everything already on the map.
  const bottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y + (n.measured?.height || n.height || 80))) + 80 : 0;
  const left = nodes.length ? Math.min(...nodes.map((n) => n.position.x)) : 0;
  const slot = () => { const p = { x: left + (placed % COLS) * GAP_X, y: bottom + Math.floor(placed / COLS) * (110 + GAP_Y) }; placed++; return p; };

  const hostIndex = new Map();
  for (const n of nextNodes) {
    if (n.type !== 'entity') continue;
    const d = n.data;
    if (d.kind === 'host' || d.kind === 'container') {
      for (const k of [d.ip, d.hostname]) if (k) hostIndex.set(k.toLowerCase(), n);
    }
  }
  const webIndex = new Map();
  for (const n of nextNodes) if (n.data?.kind === 'web' && n.data.url) webIndex.set(n.data.url.replace(/\/$/, '').toLowerCase(), n);

  const stats = { hosts: 0, ports: 0, web: 0, paths: 0, services: 0 };

  for (const h of parsed.hosts || []) {
    const key = hostKey(h.ip, h.hostname);
    if (!key) continue;
    let node = hostIndex.get(h.ip?.toLowerCase()) || hostIndex.get(h.hostname?.toLowerCase());
    if (!node) {
      node = { id: newId(), type: 'entity', position: slot(), data: { kind: 'host', ...KINDS.host.make(), label: h.hostname || h.ip, ip: h.ip || '', hostname: h.hostname || '', os: h.os || '', ports: [] } };
      nextNodes.push(node);
      created.push(node.id);
      stats.hosts++;
    } else {
      node.data.ip = node.data.ip || h.ip || '';
      node.data.hostname = node.data.hostname || h.hostname || '';
      node.data.os = node.data.os || h.os || '';
    }
    for (const k of [h.ip, h.hostname]) if (k) hostIndex.set(k.toLowerCase(), node);
    const before = (node.data.ports || []).length;
    node.data.ports = mergePorts(node.data.ports || [], h.ports || []);
    stats.ports += node.data.ports.length - before;

    if (servicesAsNodes) {
      for (const p of h.ports || []) {
        const already = nextEdges.some((e) => e.source === node.id && e.data?.label === `${p.port}/${p.proto || 'tcp'}`);
        if (already) continue;
        const s = { id: newId(), type: 'entity', position: slot(), data: { kind: 'service', ...KINDS.service.make(), label: p.service || `port ${p.port}`, port: String(p.port), proto: p.proto || 'tcp', version: p.version || '' } };
        nextNodes.push(s);
        created.push(s.id);
        nextEdges.push({ id: newId('e'), source: node.id, target: s.id, type: 'link', data: { kind: 'port', label: `${p.port}/${p.proto || 'tcp'}` } });
        stats.services++;
      }
    }
  }

  for (const p of parsed.paths || []) {
    const base = (p.base || '').replace(/\/$/, '');
    const key = base.toLowerCase() || '(sans base)';
    let node = webIndex.get(key);
    if (!node) {
      node = { id: newId(), type: 'entity', position: slot(), data: { kind: 'web', ...KINDS.web.make(), label: hostOf(base) || 'Application web', url: base, paths: [] } };
      nextNodes.push(node);
      created.push(node.id);
      webIndex.set(key, node);
      stats.web++;
      const host = hostIndex.get(hostOf(base));
      if (host) nextEdges.push({ id: newId('e'), source: host.id, target: node.id, type: 'link', data: { kind: 'http', label: /^https:/i.test(base) ? '443/tcp' : '80/tcp' } });
    }
    const before = node.data.paths.length;
    node.data.paths = mergePaths(node.data.paths, [p]);
    stats.paths += node.data.paths.length - before;
  }

  return { nodes: nextNodes, edges: nextEdges, created, stats };
}

export function describeStats(s) {
  const bits = [];
  if (s.hosts) bits.push(`${s.hosts} hôte${s.hosts > 1 ? 's' : ''}`);
  if (s.ports) bits.push(`${s.ports} port${s.ports > 1 ? 's' : ''}`);
  if (s.services) bits.push(`${s.services} service${s.services > 1 ? 's' : ''}`);
  if (s.web) bits.push(`${s.web} app${s.web > 1 ? 's' : ''} web`);
  if (s.paths) bits.push(`${s.paths} chemin${s.paths > 1 ? 's' : ''}`);
  return bits.length ? bits.join(', ') : 'rien de nouveau';
}
