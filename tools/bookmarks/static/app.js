(() => {
  const $ = (id) => document.getElementById(id);
  const api = 'api';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  const PALETTE = ['#f2b24e', '#6fb6c9', '#7fc383', '#d9a6e0', '#e8c58f', '#8fb4e8', '#e5654f', '#a7c9a2', '#c9b46f', '#8fd3e8'];
  const colour = (name) => { let h = 0; for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12H4v-2z"/></svg>';
  let data = { sites: [], families: [] };
  let editing = null;
  let admin = true;   // other accounts only add: no pencil, no delete, no rename
  fetch('/gate/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => { admin = !s.auth || s.role !== 'user'; render(); }).catch(() => {});

  async function call(url, init) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
    if (r.status === 204) return null;
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  }

  async function load() {
    try { data = await call(`${api}/sites`); render(); }
    catch (e) { status('Chargement impossible : ' + e.message, 'err'); }
  }

  function render() {
    const q = $('filter').value.trim().toLowerCase();
    const sites = data.sites.filter((s) => !q || `${s.name} ${s.description} ${hostOf(s.url)} ${s.family}`.toLowerCase().includes(q));
    const byFam = new Map();
    if (!q) for (const f of data.families) byFam.set(f, []);   // empty families show up unless filtering
    for (const s of sites) { if (!byFam.has(s.family)) byFam.set(s.family, []); byFam.get(s.family).push(s); }
    $('family-list').innerHTML = data.families.map((f) => `<option value="${esc(f)}">`).join('');
    $('families').innerHTML = [...byFam.entries()].map(([fam, list]) => `
      <section class="family" style="--accent:${colour(fam)}">
        <div class="family-head"><h2>${esc(fam)}</h2><span class="count">${list.length}</span>
          <span class="tools"><button type="button" class="add-here" data-fam="${esc(fam)}">+ site</button>${admin ? `<button type="button" class="rename" data-fam="${esc(fam)}">renommer</button>${list.length ? '' : `<button type="button" class="del" data-fam="${esc(fam)}">supprimer</button>`}` : ''}</span></div>
        ${list.length ? `<div class="sites">${list.map(card).join('')}</div>` : `<p class="family-empty">Aucun site pour l'instant. <button type="button" class="add-here" data-fam="${esc(fam)}">Ajouter le premier</button></p>`}
      </section>`).join('') || `<p class="empty">${q ? 'Rien ne correspond.' : 'Aucun signet. Ajoute le premier.'}</p>`;
    $('families').querySelectorAll('.edit').forEach((b) => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openForm(data.sites.find((s) => s.id === b.dataset.id)); });
    $('families').querySelectorAll('.rename').forEach((b) => b.onclick = () => renameFamily(b.dataset.fam));
    $('families').querySelectorAll('.add-here').forEach((b) => b.onclick = () => { openForm(null); $('f-family').value = b.dataset.fam; $('f-url').focus(); });
    $('families').querySelectorAll('.del').forEach((b) => b.onclick = () => removeFamily(b.dataset.fam));
    status(`${data.sites.length} site${data.sites.length > 1 ? 's' : ''} · ${data.families.length} famille${data.families.length > 1 ? 's' : ''}${admin ? '' : ' · ce compte peut ajouter, pas modifier'}`);
  }

  function card(s) {
    const host = hostOf(s.url);
    return `<a class="site" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">
      <div class="site-top">
        <div class="site-icon"><img src="https://icons.duckduckgo.com/ip3/${esc(host)}.ico" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:${JSON.stringify((s.name[0] || '?').toUpperCase())}}))"></div>
        <div class="site-name">${esc(s.name)}</div>
      </div>
      <div class="site-desc">${esc(s.description)}</div>
      <div class="site-host">${esc(host)}</div>
      ${admin ? `<button class="edit" type="button" data-id="${esc(s.id)}" title="Modifier">${PENCIL}</button>` : ''}
    </a>`;
  }
  $('filter').addEventListener('input', render);

  // ---- add / edit ----
  function openForm(site) {
    editing = site || null;
    $('form-title').textContent = site ? 'Modifier le signet' : 'Ajouter un site';
    $('f-url').value = site ? site.url : '';
    $('f-name').value = site ? site.name : '';
    $('f-desc').value = site ? site.description : '';
    $('f-family').value = site ? site.family : (lastFamily() || '');
    $('f-delete').hidden = !site;
    $('form-status').textContent = ''; $('form-status').className = 'status';
    $('modal').hidden = false;
    (site ? $('f-name') : $('f-url')).focus();
  }
  const lastFamily = () => { try { return localStorage.getItem('deck.bookmarks.family') || ''; } catch { return ''; } };
  function closeForm() { $('modal').hidden = true; editing = null; }
  $('add-btn').onclick = () => openForm(null);
  $('form-close').onclick = closeForm; $('f-cancel').onclick = closeForm;
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeForm(); });

  async function peek() {
    const url = $('f-url').value.trim();
    if (!url) return;
    $('form-status').textContent = 'Lecture de la page…'; $('form-status').className = 'status';
    try {
      const info = await call(`${api}/peek?url=${encodeURIComponent(url)}`);
      $('f-url').value = info.url;
      if (!$('f-name').value) $('f-name').value = info.name;
      if (!$('f-desc').value) $('f-desc').value = info.description;
      $('form-status').textContent = info.description ? 'Titre et description lus, corrige si besoin.' : 'Titre lu, pas de description sur la page.';
      $('form-status').className = 'status ok';
      (info.description ? $('f-family') : $('f-desc')).focus();
    } catch (e) { $('form-status').textContent = e.message; $('form-status').className = 'status err'; }
  }
  $('peek-btn').onclick = peek;
  $('f-url').addEventListener('change', () => { if (!editing && !$('f-name').value) peek(); });
  $('f-url').addEventListener('paste', () => setTimeout(() => { if (!editing && !$('f-name').value) peek(); }, 50));

  $('site-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { url: $('f-url').value, name: $('f-name').value, description: $('f-desc').value, family: $('f-family').value };
    $('f-save').disabled = true;
    try {
      if (editing) await call(`${api}/sites/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await call(`${api}/sites`, { method: 'POST', body: JSON.stringify(body) });
      try { localStorage.setItem('deck.bookmarks.family', body.family); } catch {}
      closeForm(); await load();
    } catch (err) { $('form-status').textContent = err.message; $('form-status').className = 'status err'; }
    finally { $('f-save').disabled = false; }
  };
  $('f-delete').onclick = async () => {
    if (!editing || !confirm(`Supprimer « ${editing.name} » ?`)) return;
    try { await call(`${api}/sites/${editing.id}`, { method: 'DELETE' }); closeForm(); await load(); }
    catch (err) { $('form-status').textContent = err.message; $('form-status').className = 'status err'; }
  };

  async function renameFamily(from) {
    const to = prompt(`Nouveau nom pour la famille « ${from} » :`, from);
    if (!to || to.trim() === from) return;
    try { await call(`${api}/families/rename`, { method: 'POST', body: JSON.stringify({ from, to: to.trim() }) }); await load(); }
    catch (e) { status(e.message, 'err'); }
  }

  async function addFamily() {
    const name = prompt('Nom de la nouvelle famille :');
    if (!name || !name.trim()) return;
    try { await call(`${api}/families`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); await load(); }
    catch (e) { status(e.message, 'err'); }
  }
  async function removeFamily(name) {
    if (!confirm(`Supprimer la famille vide « ${name} » ?`)) return;
    try { await call(`${api}/families/${encodeURIComponent(name)}`, { method: 'DELETE' }); await load(); }
    catch (e) { status(e.message, 'err'); }
  }
  $('family-btn').onclick = addFamily;

  // ---- bulk ----
  $('bulk-btn').onclick = () => { $('bulk-status').textContent = ''; $('bulk-modal').hidden = false; $('bulk-text').focus(); };
  const closeBulk = () => { $('bulk-modal').hidden = true; };
  $('bulk-close').onclick = closeBulk; $('bulk-cancel').onclick = closeBulk;
  $('bulk-modal').addEventListener('mousedown', (e) => { if (e.target === $('bulk-modal')) closeBulk(); });
  $('bulk-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const out = await call(`${api}/sites/bulk`, { method: 'POST', body: JSON.stringify({ text: $('bulk-text').value }) });
      const n = (out.added || []).length;
      $('bulk-status').textContent = `${n} ajouté${n > 1 ? 's' : ''}${out.errors && out.errors.length ? ' · ignorés : ' + out.errors.join(' ; ') : ''}`;
      $('bulk-status').className = 'status ' + (out.errors && out.errors.length ? 'err' : 'ok');
      if (n) { $('bulk-text').value = ''; await load(); }
    } catch (err) { $('bulk-status').textContent = err.message; $('bulk-status').className = 'status err'; }
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeForm(); closeBulk(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('filter').focus(); }
  });
  // drop a link or a URL anywhere on the page: straight into the add form
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text');
    if (url && /^https?:\/\//i.test(url.trim())) { openForm(null); $('f-url').value = url.trim(); peek(); }
  });
  load();
})();
