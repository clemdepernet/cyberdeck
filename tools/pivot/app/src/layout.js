import dagre from '@dagrejs/dagre';

// Auto-layout with dagre. Zones are left where they are: they are backdrops,
// not part of the graph.
export function autoLayout(nodes, edges, direction = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });
  const laid = nodes.filter((n) => n.type !== 'zone');
  for (const n of laid) g.setNode(n.id, { width: n.measured?.width || n.width || 220, height: n.measured?.height || n.height || 80 });
  const ids = new Set(laid.map((n) => n.id));
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n;
    const p = g.node(n.id);
    const w = n.measured?.width || n.width || 220, h = n.measured?.height || n.height || 80;
    return { ...n, position: { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) } };
  });
}
