import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  useNodesState, useEdgesState, useReactFlow, addEdge, ConnectionMode, MarkerType, SelectionMode,
} from '@xyflow/react';
import { KINDS, KIND_GROUPS, EDGE_KINDS, Icon, nodeTypes, edgeTypes, searchText } from './nodes.jsx';
import { NodeInspector, EdgeInspector, EmptyInspector } from './Inspector.jsx';
import ImportDialog from './ImportDialog.jsx';
import { importRecords, describeStats, newId } from './importer.js';
import { autoLayout } from './layout.js';
import { exportPng, exportPdf, exportJson, readJsonFile } from './exporter.js';
import { listMaps, getMap, createMap, updateMap, deleteMap } from './api.js';

const AUTOSAVE_MS = 1500;
const HISTORY_MAX = 60;
const timeLabel = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

// Only what deserves a file: no selection, drag or measurement state.
function serializeNodes(nodes) {
  return nodes.map(({ id, type, position, data, width, height, style, zIndex }) => ({ id, type, position: { x: Math.round(position.x), y: Math.round(position.y) }, data, width, height, style, zIndex }));
}
function serializeEdges(edges) {
  return edges.map(({ id, source, target, sourceHandle, targetHandle, type, data }) => ({ id, source, target, sourceHandle, targetHandle, type, data }));
}

function withMarker(edge) {
  const d = edge.data || { kind: 'link' };
  const color = (EDGE_KINDS[d.kind] || EDGE_KINDS.link).color;
  return { ...edge, type: 'link', data: d, markerEnd: d.arrow === false ? undefined : { type: MarkerType.ArrowClosed, width: 18, height: 18, color } };
}

function hydrateNodes(nodes) {
  return (nodes || []).map((n) => ({ ...n, type: n.type === 'zone' ? 'zone' : 'entity', data: { kind: 'note', ...(n.data || {}) } }));
}

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pv-crash">
        <h2>Pivot a planté.</h2>
        <p className="mono">{String(this.state.error && this.state.error.message)}</p>
        <button className="btn primary" onClick={() => location.reload()}>Recharger</button>
      </div>
    );
  }
}

export default function App() {
  return <Boundary><ReactFlowProvider><Editor /></ReactFlowProvider></Boundary>;
}

function Editor() {
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [maps, setMaps] = useState([]);
  const [current, setCurrent] = useState(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState({ nodes: [], edges: [] });
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState('');
  const wrapRef = useRef(null);
  const jsonRef = useRef(null);
  const timerRef = useRef(null);
  const savedRef = useRef('');      // serialized content at last save
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const stateRef = useRef({ nodes, edges, current, name });
  stateRef.current = { nodes, edges, current, name };

  const signature = useCallback((n, e, nm) => JSON.stringify({ name: (nm || '').trim() || 'Sans titre', nodes: serializeNodes(n), edges: serializeEdges(e) }), []);

  // ─── History ───
  const snapshot = useCallback(() => {
    const { nodes: n, edges: e } = stateRef.current;
    pastRef.current.push({ nodes: n, edges: e });
    if (pastRef.current.length > HISTORY_MAX) pastRef.current.shift();
    futureRef.current = [];
  }, []);
  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push({ nodes: stateRef.current.nodes, edges: stateRef.current.edges });
    setNodes(prev.nodes); setEdges(prev.edges);
  }, [setNodes, setEdges]);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push({ nodes: stateRef.current.nodes, edges: stateRef.current.edges });
    setNodes(next.nodes); setEdges(next.edges);
  }, [setNodes, setEdges]);

  // ─── Persistence ───
  const refresh = useCallback(async () => {
    try { setMaps(await listMaps()); } catch (e) { setStatus({ kind: 'error', text: e.message }); }
  }, []);

  const applyMap = useCallback((m) => {
    const n = hydrateNodes(m.nodes), e = (m.edges || []).map(withMarker);
    setNodes(n); setEdges(e);
    setCurrent({ id: m.id, name: m.name, updatedAt: m.updatedAt });
    setName(m.name);
    savedRef.current = signature(n, e, m.name);
    pastRef.current = []; futureRef.current = [];
    setTimeout(() => { if (m.viewport) rf.setViewport(m.viewport); else rf.fitView({ padding: 0.2 }); }, 30);
    history.replaceState(null, '', `?map=${m.id}`);
  }, [rf, setNodes, setEdges, signature]);

  useEffect(() => {
    (async () => {
      let list = [];
      try { list = await listMaps(); } catch (e) { setStatus({ kind: 'error', text: 'API injoignable : ' + e.message }); }
      setMaps(list);
      const wanted = new URLSearchParams(location.search).get('map');
      const pick = list.find((m) => m.id === wanted) || list[0];
      if (pick) { try { applyMap(await getMap(pick.id)); } catch { /* blank */ } }
      else savedRef.current = signature([], [], '');
      setReady(true);
    })();
  }, [applyMap, signature]);

  const save = useCallback(async (opts = {}) => {
    const { nodes: n, edges: e, current: cur, name: nm } = stateRef.current;
    const mapName = (opts.name ?? nm ?? '').trim() || 'Sans titre';
    if (!cur && n.length === 0 && !opts.force) return;
    const sig = signature(n, e, mapName);
    if (sig === savedRef.current && !opts.force) return;
    setStatus({ kind: 'saving', text: 'Enregistrement…' });
    const payload = { name: mapName, nodes: serializeNodes(n), edges: serializeEdges(e), viewport: rf.getViewport() };
    try {
      let meta;
      if (cur) meta = await updateMap(cur.id, payload);
      else { meta = await createMap(payload); history.replaceState(null, '', `?map=${meta.id}`); }
      setCurrent(meta);
      if (!nm) setName(meta.name);
      savedRef.current = sig;
      setStatus({ kind: 'saved', text: 'Enregistré à ' + timeLabel(meta.updatedAt) });
      refresh();
    } catch (err) {
      setStatus({ kind: 'error', text: 'Échec : ' + err.message });
    }
  }, [rf, refresh, signature]);

  // Mark dirty + debounce a save whenever the content (not the selection) moves.
  useEffect(() => {
    if (!ready) return;
    if (nodes.some((n) => n.dragging)) return;
    const sig = signature(nodes, edges, name);
    if (sig === savedRef.current) return;
    setStatus((s) => (s.kind === 'dirty' ? s : { kind: 'dirty', text: 'Modifications non enregistrées' }));
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(), AUTOSAVE_MS);
    return () => clearTimeout(timerRef.current);
  }, [nodes, edges, name, ready, save, signature]);

  const loadMap = useCallback(async (id) => {
    clearTimeout(timerRef.current);
    await save();
    try { applyMap(await getMap(id)); setStatus({ kind: 'saved', text: 'Carte ouverte' }); }
    catch (e) { setStatus({ kind: 'error', text: e.message }); }
  }, [applyMap, save]);

  const newMap = useCallback(async (initial) => {
    clearTimeout(timerRef.current);
    await save();
    const n = hydrateNodes(initial?.nodes || []), e = (initial?.edges || []).map(withMarker);
    setNodes(n); setEdges(e);
    setCurrent(null); setName(initial?.name || '');
    savedRef.current = initial ? '' : signature([], [], '');
    pastRef.current = []; futureRef.current = [];
    history.replaceState(null, '', location.pathname);
    setStatus({ kind: 'idle', text: 'Nouvelle carte : créée au premier nœud.' });
    if (initial) setTimeout(() => rf.fitView({ padding: 0.2 }), 30);
  }, [rf, save, setNodes, setEdges, signature]);

  const removeMap = useCallback(async () => {
    if (!current) return;
    if (!window.confirm(`Supprimer « ${current.name} » du serveur ?`)) return;
    clearTimeout(timerRef.current);
    try {
      await deleteMap(current.id);
      setNodes([]); setEdges([]); setCurrent(null); setName('');
      savedRef.current = signature([], [], '');
      history.replaceState(null, '', location.pathname);
      setStatus({ kind: 'idle', text: 'Carte supprimée.' });
      refresh();
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
  }, [current, refresh, setNodes, setEdges, signature]);

  // ─── Editing ───
  const addNode = useCallback((kind, position) => {
    const def = KINDS[kind];
    if (!def) return;
    snapshot();
    const pos = position || (() => {
      const r = wrapRef.current.getBoundingClientRect();
      const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      return { x: p.x - 100 + Math.random() * 40, y: p.y - 40 + Math.random() * 40 };
    })();
    const node = def.isZone
      ? { id: newId(), type: 'zone', position: pos, data: { kind, ...def.make() }, style: { width: 420, height: 280 }, zIndex: -1 }
      : { id: newId(), type: 'entity', position: pos, data: { kind, ...def.make() } };
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })).concat({ ...node, selected: true }));
  }, [rf, setNodes, snapshot]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('application/pivot-kind');
    if (!kind) return;
    addNode(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [addNode, rf]);

  const onConnect = useCallback((params) => {
    if (params.source === params.target) return;
    snapshot();
    setEdges((es) => addEdge(withMarker({ ...params, id: newId('e'), data: { kind: 'link', label: '' } }), es));
  }, [setEdges, snapshot]);

  const updateNodeData = useCallback((id, data) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data } : n)));
  }, [setNodes]);
  const updateEdgeData = useCallback((id, data) => {
    setEdges((es) => es.map((e) => (e.id === id ? withMarker({ ...e, data }) : e)));
  }, [setEdges]);

  const deleteSelected = useCallback(() => {
    const ids = new Set(selection.nodes), eids = new Set(selection.edges);
    if (!ids.size && !eids.size) return;
    snapshot();
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !eids.has(e.id) && !ids.has(e.source) && !ids.has(e.target)));
  }, [selection, setNodes, setEdges, snapshot]);

  const duplicateSelected = useCallback(() => {
    const ids = new Set(selection.nodes);
    if (!ids.size) return;
    snapshot();
    const map = new Map();
    const copies = stateRef.current.nodes.filter((n) => ids.has(n.id)).map((n) => {
      const id = newId(); map.set(n.id, id);
      return { ...n, id, selected: true, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: JSON.parse(JSON.stringify(n.data)) };
    });
    const edgeCopies = stateRef.current.edges.filter((e) => map.has(e.source) && map.has(e.target)).map((e) => ({ ...e, id: newId('e'), source: map.get(e.source), target: map.get(e.target), selected: false }));
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })).concat(copies));
    setEdges((es) => es.concat(edgeCopies));
  }, [selection, setNodes, setEdges, snapshot]);

  const reverseEdge = useCallback((id) => {
    snapshot();
    setEdges((es) => es.map((e) => (e.id === id ? { ...e, source: e.target, target: e.source, sourceHandle: e.targetHandle, targetHandle: e.sourceHandle } : e)));
  }, [setEdges, snapshot]);

  // One Service node per port, fanned out under the host.
  const explodePorts = useCallback((id) => {
    const host = stateRef.current.nodes.find((n) => n.id === id);
    if (!host || !(host.data.ports || []).length) return;
    snapshot();
    const ports = host.data.ports;
    const w = host.measured?.width || 220, h = host.measured?.height || 90;
    const startX = host.position.x + w / 2 - ((ports.length - 1) * 170) / 2 - 90;
    const added = ports.map((p, i) => ({
      id: newId(), type: 'entity',
      position: { x: startX + i * 170, y: host.position.y + h + 90 },
      data: { kind: 'service', label: p.service || `port ${p.port}`, port: String(p.port), proto: p.proto || 'tcp', version: p.version || '' },
    }));
    setNodes((ns) => ns.concat(added));
    setEdges((es) => es.concat(added.map((s, i) => withMarker({ id: newId('e'), source: id, target: s.id, sourceHandle: 'b', targetHandle: 't', data: { kind: 'port', label: `${ports[i].port}/${ports[i].proto || 'tcp'}` } }))));
  }, [setNodes, setEdges, snapshot]);

  const doLayout = useCallback((dir = 'LR') => {
    snapshot();
    setNodes((ns) => autoLayout(ns, stateRef.current.edges, dir));
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 30);
  }, [rf, setNodes, snapshot]);

  const onImport = useCallback((parsed, opts) => {
    snapshot();
    const res = importRecords(parsed, stateRef.current.nodes, stateRef.current.edges, opts);
    let n = res.nodes;
    const e = res.edges.map(withMarker);
    if (opts.layout) n = autoLayout(n, e, 'LR');
    const created = new Set(res.created);
    setNodes(n.map((x) => ({ ...x, selected: created.has(x.id) })));
    setEdges(e);
    setShowImport(false);
    setStatus({ kind: 'dirty', text: 'Import : ' + describeStats(res.stats) });
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 60);
  }, [rf, setNodes, setEdges, snapshot]);

  const onJsonFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const m = await readJsonFile(file);
      if (!Array.isArray(m.nodes)) throw new Error('ce fichier ne contient pas de carte');
      await newMap({ name: m.name || file.name.replace(/\.pivot\.json$|\.json$/i, ''), nodes: m.nodes, edges: m.edges || [] });
    } catch (e) { setStatus({ kind: 'error', text: 'Import JSON : ' + e.message }); }
  }, [newMap]);

  const runExport = useCallback(async (fmt) => {
    if (!nodes.length) return;
    setBusy(fmt);
    try {
      const nm = (name || '').trim() || 'Sans titre';
      rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
      await new Promise((r) => setTimeout(r, 50));
      if (fmt === 'png') await exportPng(stateRef.current.nodes, nm);
      else if (fmt === 'pdf') await exportPdf(stateRef.current.nodes, nm);
      else exportJson({ name: nm, nodes: serializeNodes(stateRef.current.nodes), edges: serializeEdges(stateRef.current.edges) });
    } catch (e) { setStatus({ kind: 'error', text: 'Export : ' + e.message }); }
    finally { setBusy(''); }
  }, [nodes.length, name, rf]);

  // ─── Keyboard ───
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); clearTimeout(timerRef.current); save({ force: true }); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
      else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); setShowImport(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, undo, redo, duplicateSelected]);

  const onSelectionChange = useCallback(({ nodes: sn, edges: se }) => {
    setSelection({ nodes: sn.map((n) => n.id), edges: se.map((e) => e.id) });
  }, []);

  // Search dims what does not match instead of hiding it.
  const q = search.trim().toLowerCase();
  const shownNodes = useMemo(() => (q ? nodes.map((n) => ({ ...n, className: searchText(n.data).includes(q) ? 'pv-hit' : 'pv-dim' })) : nodes), [nodes, q]);
  const matches = q ? shownNodes.filter((n) => n.className === 'pv-hit').length : 0;

  const selNode = selection.nodes.length === 1 ? nodes.find((n) => n.id === selection.nodes[0]) : null;
  const selEdge = !selNode && selection.edges.length === 1 ? edges.find((e) => e.id === selection.edges[0]) : null;

  if (!ready) return <div className="pv-loading">…</div>;

  return (
    <div className="pv-app">
      <header className="pv-top">
        <div className="pv-brand">
          <span className="pv-brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7 7.5l3.5 8M17 7.5l-3.5 8M7.5 6h9"/></svg></span>
          <span>Pivot</span>
        </div>
        <select className="pv-select" value={current ? current.id : ''} onChange={(e) => (e.target.value ? loadMap(e.target.value) : newMap())} title="Cartes enregistrées">
          <option value="">+ Nouvelle carte</option>
          {maps.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.nodes} nœud{m.nodes > 1 ? 's' : ''}</option>)}
        </select>
        <input className="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la carte" />
        <button className="btn small primary" onClick={() => { clearTimeout(timerRef.current); save({ force: true }); }} title="Ctrl+S">Enregistrer</button>
        {current && <button className="btn small danger" onClick={removeMap}>Supprimer</button>}
        <span className={`pv-status ${status.kind}`}>{status.text}</span>
        <span className="pv-spacer" />
        <input className="pv-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher (IP, port, service…)" />
        {q && <span className="pv-count muted">{matches} résultat{matches > 1 ? 's' : ''}</span>}
        <button className="btn small" onClick={() => setShowImport(true)} title="Ctrl+I">Importer un scan</button>
        <div className="pv-menu">
          <button className="btn small">Disposer ▾</button>
          <div className="pv-menu-list">
            <button onClick={() => doLayout('LR')}>Gauche → droite</button>
            <button onClick={() => doLayout('TB')}>Haut → bas</button>
            <button onClick={() => rf.fitView({ padding: 0.2, duration: 300 })}>Tout voir</button>
          </div>
        </div>
        <div className="pv-menu">
          <button className="btn small" disabled={!!busy}>{busy ? 'Export…' : 'Exporter ▾'}</button>
          <div className="pv-menu-list">
            <button onClick={() => runExport('png')}>Image PNG</button>
            <button onClick={() => runExport('pdf')}>Document PDF</button>
            <button onClick={() => runExport('json')}>Fichier JSON</button>
            <button onClick={() => jsonRef.current.click()}>Ouvrir un JSON…</button>
          </div>
        </div>
        <input ref={jsonRef} type="file" accept=".json,application/json" hidden onChange={(e) => { onJsonFile(e.target.files[0]); e.target.value = ''; }} />
      </header>

      <div className="pv-main">
        <aside className="pv-palette">
          {KIND_GROUPS.map((g) => (
            <div key={g} className="pv-palette-group">
              <h3>{g}</h3>
              {Object.entries(KINDS).filter(([, k]) => k.group === g).map(([id, k]) => (
                <div key={id} className="pv-palette-item" draggable style={{ '--accent': k.color }}
                  onDragStart={(e) => { e.dataTransfer.setData('application/pivot-kind', id); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => addNode(id)} title="Glisser sur la carte, ou cliquer">
                  <span className="pv-node-icon"><Icon kind={id} /></span>
                  <span>{k.label}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="pv-legend">
            <h3>Liens</h3>
            {Object.entries(EDGE_KINDS).map(([k, v]) => (
              <div key={k} className="pv-legend-row"><span className="pv-legend-line" style={{ borderColor: v.color, borderStyle: v.dashed ? 'dashed' : 'solid' }} />{v.label}</div>
            ))}
          </div>
        </aside>

        <div className="pv-canvas" ref={wrapRef} onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
          <ReactFlow
            nodes={shownNodes} edges={edges}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={() => snapshot()}
            onBeforeDelete={async () => { snapshot(); return true; }}
            onSelectionChange={onSelectionChange}
            connectionMode={ConnectionMode.Loose}
            selectionMode={SelectionMode.Partial}
            selectionOnDrag={false} panOnDrag={[0, 1]} selectionKeyCode="Shift"
            deleteKeyCode={['Delete', 'Backspace']} multiSelectionKeyCode={['Control', 'Meta']}
            snapToGrid snapGrid={[8, 8]}
            minZoom={0.1} maxZoom={2.5}
            fitView proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'link' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#3a3f47" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => (KINDS[n.data?.kind] || KINDS.note).color} maskColor="rgba(21,23,27,.7)" />
            {nodes.length === 0 && (
              <Panel position="top-center" className="pv-empty">
                <h2>Carte vide</h2>
                <p>Glisse un hôte depuis la palette, ou <button className="pv-link" onClick={() => setShowImport(true)}>importe un scan nmap, gobuster, ffuf ou dirb</button>.</p>
              </Panel>
            )}
          </ReactFlow>
        </div>

        <aside className="pv-side">
          {selNode && (
            <NodeInspector key={selNode.id} node={selNode}
              onChange={(d) => updateNodeData(selNode.id, d)} onFocusField={snapshot}
              onDelete={deleteSelected} onDuplicate={duplicateSelected} onExplode={() => explodePorts(selNode.id)} />
          )}
          {selEdge && (
            <EdgeInspector key={selEdge.id} edge={selEdge}
              onChange={(d) => updateEdgeData(selEdge.id, d)} onFocusField={snapshot}
              onDelete={deleteSelected} onReverse={() => reverseEdge(selEdge.id)} />
          )}
          {!selNode && !selEdge && selection.nodes.length > 1 && (
            <div className="pv-inspector">
              <div className="pv-insp-head"><span>{selection.nodes.length} nœuds sélectionnés</span></div>
              <div className="pv-insp-actions">
                <button className="btn small" onClick={duplicateSelected}>Dupliquer</button>
                <button className="btn small danger" onClick={deleteSelected}>Supprimer</button>
              </div>
            </div>
          )}
          {!selNode && !selEdge && selection.nodes.length <= 1 && <EmptyInspector counts={{ nodes: nodes.length, edges: edges.length }} />}
        </aside>
      </div>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} onImport={onImport} />}
    </div>
  );
}
