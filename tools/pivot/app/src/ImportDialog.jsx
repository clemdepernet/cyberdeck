import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseAny, detectFormat } from './parsers.js';

const FORMATS = { 'nmap-xml': 'nmap (XML)', nmap: 'nmap (texte)', 'nmap-grepable': 'nmap (greppable)', gobuster: 'gobuster', ffuf: 'ffuf', dirb: 'dirb' };

export default function ImportDialog({ onClose, onImport }) {
  const [text, setText] = useState('');
  const [forced, setForced] = useState('');
  const [services, setServices] = useState(false);
  const [layout, setLayout] = useState(true);
  const fileRef = useRef(null);

  const format = forced || detectFormat(text);
  const parsed = useMemo(() => (text.trim() && format ? parseAny(text, format) : null), [text, format]);
  const summary = parsed ? {
    hosts: parsed.hosts.length,
    ports: parsed.hosts.reduce((n, h) => n + h.ports.length, 0),
    paths: parsed.paths.length,
  } : null;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const readFiles = async (files) => {
    const parts = [];
    for (const f of files) parts.push(await f.text());
    setText((t) => [t, ...parts].filter(Boolean).join('\n\n'));
  };

  return (
    <div className="pv-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pv-modal" onDrop={(e) => { e.preventDefault(); readFiles(e.dataTransfer.files); }} onDragOver={(e) => e.preventDefault()}>
        <div className="pv-modal-head">
          <h2>Importer un scan</h2>
          <button className="pv-x" onClick={onClose} title="Fermer">×</button>
        </div>
        <p className="muted">Colle la sortie de nmap (-oN, -oX, -oG), gobuster, ffuf (texte ou -o json) ou dirb, ou dépose le fichier ici. Le format est détecté tout seul.</p>
        <textarea className="mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Nmap scan report for 10.10.10.5\n22/tcp open ssh OpenSSH 8.9\n80/tcp open http nginx 1.18.0'} autoFocus />
        <div className="toolbar">
          <button className="btn small" onClick={() => fileRef.current.click()}>Fichier…</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => readFiles(e.target.files)} />
          <label>Format
            <select value={forced} onChange={(e) => setForced(e.target.value)}>
              <option value="">auto{format && !forced ? ` (${FORMATS[format]})` : ''}</option>
              {Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="pv-check"><input type="checkbox" checked={services} onChange={(e) => setServices(e.target.checked)} /> un nœud Service par port</label>
          <label className="pv-check"><input type="checkbox" checked={layout} onChange={(e) => setLayout(e.target.checked)} /> réorganiser après import</label>
        </div>
        <div className="pv-modal-foot">
          <span className={summary ? 'ok' : 'dim'}>
            {text.trim() && !format && 'Format non reconnu : choisis-le à la main.'}
            {summary && `${summary.hosts} hôte(s), ${summary.ports} port(s), ${summary.paths} chemin(s) détectés`}
          </span>
          <button className="btn primary" disabled={!parsed} onClick={() => onImport(parsed, { servicesAsNodes: services, layout })}>Importer</button>
        </div>
      </div>
    </div>
  );
}
