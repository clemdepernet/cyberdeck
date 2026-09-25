import React from 'react';
import { KINDS, EDGE_KINDS, Icon } from './nodes.jsx';

// Right-hand panel: edits the selected node's data or the selected edge.
// `onFocusField` lets the app snapshot history before a field is edited.

function PortsTable({ rows, onChange }) {
  const set = (i, key, value) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  return (
    <div className="pv-table">
      {rows.length > 0 && (
        <div className="pv-table-head"><span>Port</span><span>Proto</span><span>Service</span><span>Version</span><span /></div>
      )}
      {rows.map((r, i) => (
        <div className="pv-table-row" key={i}>
          <input className="mono" value={r.port ?? ''} onChange={(e) => set(i, 'port', e.target.value)} placeholder="80" />
          <select value={r.proto || 'tcp'} onChange={(e) => set(i, 'proto', e.target.value)}><option>tcp</option><option>udp</option></select>
          <input className="mono" value={r.service || ''} onChange={(e) => set(i, 'service', e.target.value)} placeholder="http" />
          <input value={r.version || ''} onChange={(e) => set(i, 'version', e.target.value)} placeholder="nginx 1.18" />
          <button className="pv-x" title="Retirer" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...rows, { port: '', proto: 'tcp', service: '', version: '' }])}>+ Port</button>
    </div>
  );
}

function PathsTable({ rows, onChange }) {
  const set = (i, key, value) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  return (
    <div className="pv-table paths">
      {rows.length > 0 && <div className="pv-table-head"><span>Chemin</span><span>Code</span><span>Taille</span><span /></div>}
      {rows.map((r, i) => (
        <div className="pv-table-row" key={i}>
          <input className="mono" value={r.path || ''} onChange={(e) => set(i, 'path', e.target.value)} placeholder="/admin" />
          <input className="mono" value={r.status ?? ''} onChange={(e) => set(i, 'status', e.target.value ? Number(e.target.value) : undefined)} placeholder="200" />
          <input className="mono" value={r.size ?? ''} onChange={(e) => set(i, 'size', e.target.value ? Number(e.target.value) : undefined)} placeholder="1234" />
          <button className="pv-x" title="Retirer" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...rows, { path: '/', status: 200 }])}>+ Chemin</button>
    </div>
  );
}

function Field({ f, value, onChange, onFocus }) {
  const common = { onFocus, id: `pv-f-${f.key}` };
  switch (f.type) {
    case 'textarea': return <textarea {...common} rows={4} value={value || ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'select': return (
      <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => <option key={o} value={o}>{o || '—'}</option>)}
      </select>
    );
    case 'ports': return <PortsTable rows={value || []} onChange={(rows) => { onFocus(); onChange(rows); }} />;
    case 'paths': return <PathsTable rows={value || []} onChange={(rows) => { onFocus(); onChange(rows); }} />;
    default: return <input {...common} type="text" className={f.type === 'mono' ? 'mono' : ''} value={value || ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function NodeInspector({ node, onChange, onFocusField, onDelete, onDuplicate, onExplode }) {
  const kind = KINDS[node.data.kind] || KINDS.note;
  const set = (key, value) => onChange({ ...node.data, [key]: value });
  const canExplode = (node.data.ports || []).length > 0;
  return (
    <div className="pv-inspector">
      <div className="pv-insp-head" style={{ '--accent': kind.color }}>
        <span className="pv-node-icon"><Icon kind={node.data.kind} /></span>
        <span>{kind.label}</span>
      </div>
      {kind.fields.map((f) => (
        <label key={f.key} className="pv-field">
          <span>{f.label}</span>
          <Field f={f} value={node.data[f.key]} onChange={(v) => set(f.key, v)} onFocus={onFocusField} />
        </label>
      ))}
      <div className="pv-insp-actions">
        {canExplode && <button className="btn small" onClick={onExplode} title="Un nœud Service par port, relié à l'hôte">Éclater les ports</button>}
        <button className="btn small" onClick={onDuplicate}>Dupliquer</button>
        <button className="btn small danger" onClick={onDelete}>Supprimer</button>
      </div>
    </div>
  );
}

export function EdgeInspector({ edge, onChange, onFocusField, onDelete, onReverse }) {
  const d = edge.data || {};
  const set = (key, value) => onChange({ ...d, [key]: value });
  return (
    <div className="pv-inspector">
      <div className="pv-insp-head" style={{ '--accent': (EDGE_KINDS[d.kind] || EDGE_KINDS.link).color }}>
        <span>Lien</span>
      </div>
      <label className="pv-field"><span>Libellé</span>
        <input type="text" className="mono" value={d.label || ''} placeholder="443/tcp, HTTPS, réplication…" onFocus={onFocusField} onChange={(e) => set('label', e.target.value)} />
      </label>
      <label className="pv-field"><span>Type</span>
        <select value={d.kind || 'link'} onFocus={onFocusField} onChange={(e) => set('kind', e.target.value)}>
          {Object.entries(EDGE_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </label>
      <label className="pv-field row"><input type="checkbox" checked={!!d.straight} onChange={(e) => { onFocusField(); set('straight', e.target.checked); }} /><span>Ligne droite</span></label>
      <label className="pv-field row"><input type="checkbox" checked={d.arrow !== false} onChange={(e) => { onFocusField(); set('arrow', e.target.checked); }} /><span>Flèche</span></label>
      <div className="pv-insp-actions">
        <button className="btn small" onClick={onReverse}>Inverser</button>
        <button className="btn small danger" onClick={onDelete}>Supprimer</button>
      </div>
    </div>
  );
}

export function EmptyInspector({ counts }) {
  return (
    <div className="pv-inspector empty">
      <p className="muted">Sélectionne un élément pour l'éditer.</p>
      <p className="dim">{counts.nodes} nœud{counts.nodes > 1 ? 's' : ''} · {counts.edges} lien{counts.edges > 1 ? 's' : ''}</p>
      <ul className="pv-help">
        <li>Glisse une entité depuis la palette, ou clique dessus.</li>
        <li>Tire depuis le bord d'un nœud vers un autre pour créer un lien.</li>
        <li><kbd>Suppr</kbd> efface, <kbd>Ctrl+Z</kbd> annule, <kbd>Ctrl+D</kbd> duplique, <kbd>Ctrl+S</kbd> enregistre.</li>
        <li><kbd>Maj</kbd> + glisser sélectionne une zone, molette pour zoomer.</li>
      </ul>
    </div>
  );
}
