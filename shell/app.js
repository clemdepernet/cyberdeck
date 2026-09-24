// Cyberdeck shell. Reads tools.json (generated at build time from tools/*/tool.json),
// renders one tab per tool and lazily mounts each tool in its own iframe.
// Once mounted, an iframe stays alive so a tool keeps its state across tab switches.
(() => {
  const ICONS = {
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 12l3-3 3 2 4-4"/></svg>',
    paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8M8 16h5"/></svg>',
    braces: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 13l9 5 9-5M3 18l9 5 9-5" opacity=".55"/></svg>',
    tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0 5 5L14 17a2 2 0 0 1-3 0l-4-4a2 2 0 0 1 0-3l5.7-5.7z"/><path d="m3 21 5-5"/></svg>',
  };

  const rail = document.getElementById('rail');
  const tabsEl = document.getElementById('tabs');
  const stage = document.getElementById('stage');
  const home = document.getElementById('home');
  const homeGrid = document.getElementById('home-grid');
  const frames = new Map();
  let tools = [];
  let current = null;

  const iconFor = (t) => (t.icon && t.icon.trim().startsWith('<svg')) ? t.icon : (ICONS[t.icon] || ICONS.tool);

  function render() {
    tabsEl.innerHTML = '';
    homeGrid.innerHTML = '';
    tools.forEach((t, i) => {
      const a = document.createElement('a');
      a.className = 'tab';
      a.href = '#' + t.id;
      a.dataset.id = t.id;
      a.title = `${t.name} — ${t.tagline || ''}`;
      a.innerHTML = `<span class="tab-icon">${iconFor(t)}</span>
        <span class="tab-text"><span class="tab-name">${esc(t.name)}</span><span class="tab-tech">${esc(t.tech || '')}</span></span>
        ${i < 9 ? `<span class="tab-key">${i + 1}</span>` : ''}`;
      tabsEl.appendChild(a);

      const c = document.createElement('a');
      c.className = 'card';
      c.href = '#' + t.id;
      c.innerHTML = `<span class="card-head">${iconFor(t)}<span class="card-name">${esc(t.name)}</span></span>
        <span class="card-tag">${esc(t.tagline || '')}</span>
        <span class="card-tech">${esc(t.tech || '')}</span>`;
      homeGrid.appendChild(c);
    });
  }

  function open(id, query) {
    const tool = tools.find((t) => t.id === id);
    current = tool ? tool.id : null;
    home.hidden = !!tool;
    for (const [fid, f] of frames) f.hidden = fid !== current;
    tabsEl.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.id === current));
    document.title = tool ? `${tool.name} · Cyberdeck` : 'Cyberdeck';
    if (!tool) return;
    let f = frames.get(tool.id);
    const src = tool.path + (query ? (tool.path.includes('?') ? '&' : '?') + query : '');
    if (!f) {
      f = document.createElement('iframe');
      f.title = tool.name;
      f.src = src;
      f.allow = 'clipboard-read; clipboard-write';
      frames.set(tool.id, f);
      stage.appendChild(f);
    } else if (query) {
      f.src = src; // deep link with parameters: reload the tool with them
    }
    f.hidden = false;
    f.focus();
  }

  function route() {
    const hash = location.hash.replace(/^#/, '');
    const [id, query] = hash.split('?');
    open(id, query);
  }

  document.getElementById('toggle').addEventListener('click', () => {
    rail.classList.toggle('collapsed');
    try { localStorage.setItem('deck.rail', rail.classList.contains('collapsed') ? '1' : '0'); } catch {}
  });
  try { if (localStorage.getItem('deck.rail') === '1') rail.classList.add('collapsed'); } catch {}

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === '0') { e.preventDefault(); document.getElementById('toggle').click(); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && tools[n - 1]) { e.preventDefault(); location.hash = tools[n - 1].id; }
  });
  // Tools relay Alt+digit from inside their iframe (see theme.js contract) via postMessage.
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'deck:switch' && typeof e.data.index === 'number' && tools[e.data.index]) {
      location.hash = tools[e.data.index].id;
    } else if (e.data && e.data.type === 'deck:toggle') {
      document.getElementById('toggle').click();
    }
  });
  window.addEventListener('hashchange', route);

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  fetch('tools.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .then((list) => { tools = list; render(); route(); })
    .catch(() => { homeGrid.innerHTML = '<p class="err">tools.json introuvable : le manifeste n\'a pas été généré au build.</p>'; });
})();
