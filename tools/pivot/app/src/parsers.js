// Turns scanner output into plain records. No DOM APIs so the same code runs
// in the browser and under `node --test`.
//
// Returned shape:
//   { hosts: [{ ip, hostname, os, ports: [{ port, proto, state, service, version }] }],
//     paths: [{ base, path, status, size, words }] }

const empty = () => ({ hosts: [], paths: [] });

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : '';
}

export function parseNmapXML(text) {
  const out = empty();
  const hostBlocks = text.match(/<host\b[\s\S]*?<\/host>/g) || [];
  for (const block of hostBlocks) {
    const addrs = block.match(/<address\b[^>]*>/g) || [];
    const ipTag = addrs.find((a) => /addrtype="ipv[46]"/.test(a));
    if (!ipTag) continue;
    const host = { ip: attr(ipTag, 'addr'), hostname: '', os: '', ports: [] };
    const hn = /<hostname\b[^>]*>/.exec(block);
    if (hn) host.hostname = attr(hn[0], 'name');
    const os = /<osmatch\b[^>]*>/.exec(block);
    if (os) host.os = attr(os[0], 'name');
    for (const p of block.match(/<port\b[\s\S]*?<\/port>/g) || []) {
      const open = /<port\b[^>]*>/.exec(p)[0];
      const state = /<state\b[^>]*>/.exec(p);
      const svc = /<service\b[^>]*>/.exec(p);
      const st = state ? attr(state[0], 'state') : '';
      if (st !== 'open') continue;
      host.ports.push({
        port: Number(attr(open, 'portid')),
        proto: attr(open, 'protocol') || 'tcp',
        state: st,
        service: svc ? attr(svc[0], 'name') : '',
        version: svc ? [attr(svc[0], 'product'), attr(svc[0], 'version'), attr(svc[0], 'extrainfo')].filter(Boolean).join(' ') : '',
      });
    }
    out.hosts.push(host);
  }
  return out;
}

export function parseNmapNormal(text) {
  const out = empty();
  let host = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^Nmap scan report for (\S+)(?: \(([\d.:a-fA-F]+)\))?/.exec(line);
    if (m) {
      const ip = m[2] || m[1];
      host = { ip, hostname: m[2] ? m[1] : '', os: '', ports: [] };
      out.hosts.push(host);
      continue;
    }
    if (!host) continue;
    m = /^(\d+)\/(tcp|udp)\s+(open|open\|filtered)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) {
      host.ports.push({ port: Number(m[1]), proto: m[2], state: 'open', service: m[4], version: m[5].trim() });
      continue;
    }
    m = /^(?:OS details|Running): (.+)$/.exec(line);
    if (m && !host.os) host.os = m[1];
  }
  return out;
}

export function parseNmapGrepable(text) {
  const out = empty();
  for (const line of text.split(/\r?\n/)) {
    const m = /^Host: (\S+)\s+\(([^)]*)\)\s+(?:Status: Up\s*)?(?:Ports: (.*?))?(?:\s+Ignored State.*)?$/.exec(line.trim());
    if (!m || !m[3]) continue;
    const host = { ip: m[1], hostname: m[2], os: '', ports: [] };
    for (const entry of m[3].split(/,\s*/)) {
      const f = entry.split('/');
      if (f.length < 5 || f[1] !== 'open') continue;
      host.ports.push({ port: Number(f[0]), proto: f[2], state: 'open', service: f[4] || '', version: (f[6] || '').trim() });
    }
    out.hosts.push(host);
  }
  return out;
}

const statusOf = (s) => (s ? Number(s) : undefined);

export function parseGobuster(text) {
  const out = empty();
  let base = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^\[\+\]\s*Url:\s*(\S+)/i.exec(line);
    if (m) { base = m[1]; continue; }
    // dir mode: /admin (Status: 200) [Size: 1234] [--> /admin/]
    m = /^(\/\S*)\s+\(Status:\s*(\d+)\)\s*(?:\[Size:\s*(\d+)\])?/.exec(line);
    if (m) { out.paths.push({ base, path: m[1], status: statusOf(m[2]), size: statusOf(m[3]) }); continue; }
    // dns / vhost mode: Found: dev.example.com
    m = /^Found:\s*(\S+)/.exec(line);
    if (m) out.hosts.push({ ip: '', hostname: m[1], os: '', ports: [] });
  }
  return out;
}

export function parseFfuf(text) {
  const out = empty();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      const base = (j.config && j.config.url) || '';
      for (const r of j.results || []) {
        const url = r.url || '';
        const path = url.replace(/^https?:\/\/[^/]+/, '') || '/' + (r.input && (r.input.FUZZ || Object.values(r.input)[0])) || '';
        out.paths.push({ base: base.replace(/\/?FUZZ.*$/, ''), path, status: r.status, size: r.length, words: r.words });
      }
      return out;
    } catch { /* fall through to text */ }
  }
  let base = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
    let m = /^:: URL\s*:\s*(\S+)/.exec(line);
    if (m) { base = m[1].replace(/\/?FUZZ.*$/, ''); continue; }
    m = /^(\S+)\s+\[Status:\s*(\d+),\s*Size:\s*(\d+)(?:,\s*Words:\s*(\d+))?/.exec(line);
    if (m) out.paths.push({ base, path: m[1].startsWith('/') ? m[1] : '/' + m[1], status: statusOf(m[2]), size: statusOf(m[3]), words: statusOf(m[4]) });
  }
  return out;
}

export function parseDirb(text) {
  const out = empty();
  let base = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^URL_BASE:\s*(\S+)/.exec(line);
    if (m) { base = m[1].replace(/\/$/, ''); continue; }
    m = /^\+\s*(\S+)\s+\(CODE:(\d+)\|SIZE:(\d+)\)/.exec(line);
    if (m) {
      const url = m[1];
      const b = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
      out.paths.push({ base: base || b, path: url.replace(/^https?:\/\/[^/]+/, ''), status: statusOf(m[2]), size: statusOf(m[3]) });
      continue;
    }
    m = /^==> DIRECTORY:\s*(\S+)/.exec(line);
    if (m) out.paths.push({ base: base || m[1].replace(/^(https?:\/\/[^/]+).*$/, '$1'), path: m[1].replace(/^https?:\/\/[^/]+/, ''), status: 301 });
  }
  return out;
}

export function detectFormat(text) {
  const t = text.trim();
  if (/<nmaprun\b/.test(t)) return 'nmap-xml';
  if (/^Host: \S+ \(/m.test(t) && /Ports:/.test(t)) return 'nmap-grepable';
  if (/Nmap scan report for/.test(t)) return 'nmap';
  if (/^\s*\{[\s\S]*"results"\s*:/.test(t) || /\[Status:\s*\d+,\s*Size:/.test(t) || /^:: (URL|Method)\s*:/m.test(t)) return 'ffuf';
  if (/\(CODE:\d+\|SIZE:\d+\)/.test(t) || /^URL_BASE:/m.test(t)) return 'dirb';
  if (/\(Status:\s*\d+\)/.test(t) || /^\[\+\]\s*Url:/m.test(t) || /^Found:\s*\S+/m.test(t)) return 'gobuster';
  return null;
}

export function parseAny(text, format = detectFormat(text)) {
  switch (format) {
    case 'nmap-xml': return parseNmapXML(text);
    case 'nmap-grepable': return parseNmapGrepable(text);
    case 'nmap': return parseNmapNormal(text);
    case 'gobuster': return parseGobuster(text);
    case 'ffuf': return parseFfuf(text);
    case 'dirb': return parseDirb(text);
    default: return null;
  }
}
