(() => {
  // What this account may do, as told by the gate (open deck: everything).
  const role = { admin: true, create: true, note: '' };
  fetch('/gate/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => {
    if (!s.auth) return;
    role.admin = s.role === 'admin';
    role.create = s.role !== 'anon';
    role.note = s.role === 'anon' ? 'Connecte-toi pour créer un lien.' : s.role === 'user' ? 'Ce compte peut créer un lien par jour, sans en supprimer.' : '';
    if (typeof load === 'function') load();
  }).catch(() => {});
  const $ = (id) => document.getElementById(id);
  const api = '/links/api/links';
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => iso && !iso.startsWith('0001') ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais';

  async function load() {
    const r = await fetch(api);
    const d = await r.json();
    $('quota-n').textContent = d.used; $('quota-max').textContent = d.max;
    $('quota').classList.toggle('full', d.used >= d.max);
    $('submit').disabled = d.used >= d.max || !role.create;
    $('submit').textContent = d.used >= d.max ? 'Limite atteinte' : !role.create ? 'Connexion requise' : 'Raccourcir';
    if (role.note) status(role.note);
    $('empty').hidden = d.links.length > 0;
    $('list').innerHTML = d.links.map((l) => `
      <div class="link panel" data-slug="${esc(l.slug)}">
        <img src="${api}/${encodeURIComponent(l.slug)}/qr.png" alt="QR ${esc(l.slug)}" loading="lazy">
        <div class="link-main">
          <a class="short" href="${esc(l.short)}" target="_blank" rel="noopener">${esc(l.short)}</a>
          <span class="target" title="${esc(l.url)}">${esc(l.title ? l.title + ' · ' : '')}${esc(l.url)}</span>
          <span class="meta">${l.clicks} clic${l.clicks > 1 ? 's' : ''} · dernier : ${when(l.last_click)} · créé le ${when(l.created_at)}</span>
        </div>
        <div class="actions">
          <button class="btn small" data-copy="${esc(l.short)}">Copier</button>
          ${role.admin ? `<button class="btn small danger" data-del="${esc(l.slug)}">Supprimer</button>` : ''}
        </div>
      </div>`).join('');
  }

  $('form').onsubmit = async (e) => {
    e.preventDefault();
    status('Création…');
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: $('url').value.trim(), slug: $('slug').value.trim(), title: $('title').value.trim() }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      $('form').reset();
      try { await navigator.clipboard.writeText(out.short); status(out.short + ' créé et copié.', 'ok'); }
      catch { status(out.short + ' créé.', 'ok'); }
      load();
    } catch (err) {
      status(err.message, 'err');
    }
  };

  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) {
      try { await navigator.clipboard.writeText(b.dataset.copy); status('Copié : ' + b.dataset.copy, 'ok'); }
      catch { status('Copie impossible.', 'err'); }
    } else if (b.dataset.del) {
      if (!confirm(`Supprimer /s/${b.dataset.del} ? Les visiteurs auront une erreur 404.`)) return;
      const r = await fetch(`${api}/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      status(r.ok ? 'Lien supprimé.' : 'Suppression impossible.', r.ok ? 'ok' : 'err');
      load();
    }
  });

  load().catch(() => status('API injoignable.', 'err'));
})();
