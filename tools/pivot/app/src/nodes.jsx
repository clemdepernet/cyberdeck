import React, { memo } from 'react';
import { Handle, Position, NodeResizer, BaseEdge, EdgeLabelRenderer, getBezierPath, getStraightPath } from '@xyflow/react';

// ─── Entity catalogue ────────────────────────────────────────────────────────
// Every entity the map can hold. `fields` drives the inspector form, `make`
// gives the default data when the entity is dropped from the palette.
// Field types: text · mono · textarea · select · ports · paths.

const notes = { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Observations, références, commandes…' };

export const KINDS = {
  host: {
    label: 'Hôte', group: 'Machines', color: '#6fb6c9',
    icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'web-01' },
      { key: 'ip', label: 'Adresse IP', type: 'mono', placeholder: '10.10.10.5' },
      { key: 'hostname', label: 'Nom DNS', type: 'mono', placeholder: 'web.corp.local' },
      { key: 'os', label: 'Système', type: 'text', placeholder: 'Ubuntu 22.04' },
      { key: 'role', label: 'Rôle', type: 'select', options: ['', 'serveur', 'poste de travail', 'hyperviseur', 'imprimante', 'IoT', 'autre'] },
      { key: 'ports', label: 'Ports ouverts', type: 'ports' },
      notes,
    ],
    make: () => ({ label: 'Hôte', ip: '', hostname: '', os: '', role: '', ports: [] }),
  },
  container: {
    label: 'Conteneur', group: 'Machines', color: '#8fb4e8',
    icon: '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v8l9 4 9-4V8"/><path d="M12 12v8"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'api' },
      { key: 'image', label: 'Image', type: 'mono', placeholder: 'nginx:1.25' },
      { key: 'ip', label: 'Adresse IP', type: 'mono', placeholder: '172.18.0.3' },
      { key: 'ports', label: 'Ports exposés', type: 'ports' },
      notes,
    ],
    make: () => ({ label: 'Conteneur', image: '', ip: '', ports: [] }),
  },
  service: {
    label: 'Service', group: 'Services', color: '#a7c9a2',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'http' },
      { key: 'port', label: 'Port', type: 'mono', placeholder: '443' },
      { key: 'proto', label: 'Protocole', type: 'select', options: ['tcp', 'udp'] },
      { key: 'version', label: 'Produit / version', type: 'text', placeholder: 'nginx 1.18.0' },
      notes,
    ],
    make: () => ({ label: 'Service', port: '', proto: 'tcp', version: '' }),
  },
  web: {
    label: 'Application web', group: 'Services', color: '#d9a6e0',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'Portail RH' },
      { key: 'url', label: 'URL', type: 'mono', placeholder: 'https://10.10.10.5' },
      { key: 'tech', label: 'Technologies', type: 'text', placeholder: 'PHP 8, WordPress 6.4' },
      { key: 'paths', label: 'Chemins découverts', type: 'paths' },
      notes,
    ],
    make: () => ({ label: 'Application web', url: '', tech: '', paths: [] }),
  },
  database: {
    label: 'Base de données', group: 'Services', color: '#c9b46f',
    icon: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'crm-db' },
      { key: 'engine', label: 'Moteur', type: 'text', placeholder: 'PostgreSQL 15' },
      { key: 'ip', label: 'Adresse', type: 'mono', placeholder: '10.10.10.20:5432' },
      notes,
    ],
    make: () => ({ label: 'Base de données', engine: '', ip: '' }),
  },
  network: {
    label: 'Équipement réseau', group: 'Réseau', color: '#9a9585',
    icon: '<rect x="2" y="9" width="20" height="6" rx="1.5"/><path d="M6 12h.01M10 12h.01M14 12h.01"/><path d="M12 15v4M6 19h12"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'fw-edge' },
      { key: 'kindOf', label: 'Type', type: 'select', options: ['pare-feu', 'routeur', 'switch', 'load balancer', 'VPN', 'proxy', 'WAF', 'point d’accès'] },
      { key: 'ip', label: 'Adresse IP', type: 'mono', placeholder: '10.10.10.1' },
      notes,
    ],
    make: () => ({ label: 'Pare-feu', kindOf: 'pare-feu', ip: '' }),
  },
  cloud: {
    label: 'Cloud', group: 'Réseau', color: '#8fd3e8',
    icon: '<path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7z"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'bucket-backups' },
      { key: 'provider', label: 'Fournisseur', type: 'select', options: ['AWS', 'Azure', 'GCP', 'OVH', 'Scaleway', 'autre'] },
      { key: 'resource', label: 'Ressource', type: 'mono', placeholder: 's3://…, VM, fonction…' },
      notes,
    ],
    make: () => ({ label: 'Cloud', provider: 'AWS', resource: '' }),
  },
  internet: {
    label: 'Internet', group: 'Réseau', color: '#c7c2b4',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M2 12h20M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'Internet' },
      { key: 'ip', label: 'Adresse / plage', type: 'mono', placeholder: '203.0.113.0/24' },
      notes,
    ],
    make: () => ({ label: 'Internet', ip: '' }),
  },
  zone: {
    label: 'Zone réseau', group: 'Réseau', color: '#f2b24e', isZone: true,
    icon: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/>',
    fields: [
      { key: 'label', label: 'Nom', type: 'text', placeholder: 'DMZ' },
      { key: 'cidr', label: 'Plage', type: 'mono', placeholder: '10.10.10.0/24' },
      { key: 'vlan', label: 'VLAN', type: 'mono', placeholder: '20' },
      notes,
    ],
    make: () => ({ label: 'Zone', cidr: '', vlan: '' }),
  },
  note: {
    label: 'Note', group: 'Annotations', color: '#ece7dc',
    icon: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4M8 12h8M8 16h8"/>',
    fields: [
      { key: 'label', label: 'Titre', type: 'text', placeholder: 'À vérifier' },
      { key: 'text', label: 'Texte', type: 'textarea', placeholder: 'Texte libre affiché sur la carte' },
    ],
    make: () => ({ label: 'Note', text: '' }),
  },
};

export const KIND_GROUPS = [...new Set(Object.values(KINDS).map((k) => k.group))];

// ─── Edge catalogue ──────────────────────────────────────────────────────────
export const EDGE_KINDS = {
  link: { label: 'Lien', color: '#6d695f', dashed: false, animated: false },
  port: { label: 'Port', color: '#6fb6c9', dashed: false, animated: false },
  http: { label: 'Requête HTTP', color: '#d9a6e0', dashed: true, animated: false },
  data: { label: 'Flux de données', color: '#c9b46f', dashed: false, animated: true },
  tunnel: { label: 'Tunnel / VPN', color: '#7fc383', dashed: true, animated: true },
  trust: { label: 'Relation de confiance', color: '#f2b24e', dashed: true, animated: false },
  depends: { label: 'Dépend de', color: '#9a9585', dashed: false, animated: false },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function subtitleOf(data) {
  const d = data || {};
  switch (d.kind) {
    case 'host': return [d.ip, d.hostname].filter(Boolean).join(' · ') || d.os || '';
    case 'container': return [d.image, d.ip].filter(Boolean).join(' · ');
    case 'service': return [d.port ? `${d.port}/${d.proto || 'tcp'}` : '', d.version].filter(Boolean).join(' · ');
    case 'web': return d.url || d.tech || '';
    case 'database': return [d.engine, d.ip].filter(Boolean).join(' · ');
    case 'network': return [d.kindOf, d.ip].filter(Boolean).join(' · ');
    case 'cloud': return [d.provider, d.resource].filter(Boolean).join(' · ');
    case 'internet': return d.ip || '';
    case 'zone': return [d.cidr, d.vlan ? `VLAN ${d.vlan}` : ''].filter(Boolean).join(' · ');
    default: return '';
  }
}

export function searchText(data) {
  const d = data || {};
  const bits = [d.label, d.ip, d.hostname, d.os, d.image, d.url, d.tech, d.engine, d.kindOf, d.provider, d.resource, d.cidr, d.text, d.notes, d.version, d.port];
  for (const p of d.ports || []) bits.push(p.port, p.service, p.version);
  for (const p of d.paths || []) bits.push(p.path);
  return bits.filter(Boolean).join(' ').toLowerCase();
}

const Icon = ({ kind, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    dangerouslySetInnerHTML={{ __html: (KINDS[kind] || KINDS.note).icon }} />
);
export { Icon };

const handles = (
  <>
    <Handle type="source" position={Position.Top} id="t" />
    <Handle type="source" position={Position.Right} id="r" />
    <Handle type="source" position={Position.Bottom} id="b" />
    <Handle type="source" position={Position.Left} id="l" />
  </>
);

const MAX_CHIPS = 8;

// ─── Node renderers ──────────────────────────────────────────────────────────
export const EntityNode = memo(function EntityNode({ data, selected }) {
  const kind = KINDS[data.kind] || KINDS.note;
  const sub = subtitleOf(data);
  const ports = data.ports || [];
  const paths = data.paths || [];
  return (
    <div className={`pv-node kind-${data.kind}${selected ? ' selected' : ''}`} style={{ '--accent': kind.color }}>
      {handles}
      <div className="pv-node-head">
        <span className="pv-node-icon"><Icon kind={data.kind} /></span>
        <span className="pv-node-title" title={data.label}>{data.label || kind.label}</span>
      </div>
      {sub && <div className="pv-node-sub mono" title={sub}>{sub}</div>}
      {data.kind === 'note' && data.text && <div className="pv-node-text">{data.text}</div>}
      {ports.length > 0 && (
        <div className="pv-chips">
          {ports.slice(0, MAX_CHIPS).map((p, i) => (
            <span key={i} className="pv-chip" title={[p.service, p.version].filter(Boolean).join(' ')}>
              {p.port}{p.proto === 'udp' ? '/udp' : ''}{p.service ? ` ${p.service}` : ''}
            </span>
          ))}
          {ports.length > MAX_CHIPS && <span className="pv-chip more">+{ports.length - MAX_CHIPS}</span>}
        </div>
      )}
      {paths.length > 0 && (
        <div className="pv-chips">
          {paths.slice(0, MAX_CHIPS).map((p, i) => (
            <span key={i} className={`pv-chip status-${String(p.status || '')[0]}`} title={`${p.status || ''} ${p.size != null ? p.size + ' o' : ''}`}>{p.path}</span>
          ))}
          {paths.length > MAX_CHIPS && <span className="pv-chip more">+{paths.length - MAX_CHIPS}</span>}
        </div>
      )}
    </div>
  );
});

export const ZoneNode = memo(function ZoneNode({ data, selected }) {
  const sub = subtitleOf(data);
  return (
    <div className={`pv-zone${selected ? ' selected' : ''}`} style={{ '--accent': data.color || KINDS.zone.color }}>
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100} lineClassName="pv-zone-resize" handleClassName="pv-zone-handle" />
      {handles}
      <div className="pv-zone-head">
        <Icon kind="zone" size={14} />
        <span className="pv-zone-title">{data.label || 'Zone'}</span>
        {sub && <span className="pv-zone-sub mono">{sub}</span>}
      </div>
    </div>
  );
});

export const nodeTypes = { entity: EntityNode, zone: ZoneNode };

// ─── Edge renderer ───────────────────────────────────────────────────────────
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }) {
  const kind = EDGE_KINDS[(data && data.kind) || 'link'] || EDGE_KINDS.link;
  const straight = data && data.straight;
  const [path, lx, ly] = straight
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const label = data && data.label;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd}
        className={`pv-edge${kind.animated ? ' animated' : ''}${selected ? ' selected' : ''}`}
        style={{ stroke: kind.color, strokeWidth: selected ? 2.5 : 1.6, strokeDasharray: kind.dashed ? '6 4' : undefined }} />
      {label && (
        <EdgeLabelRenderer>
          <div className={`pv-edge-label${selected ? ' selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, '--accent': kind.color }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { link: LinkEdge };
