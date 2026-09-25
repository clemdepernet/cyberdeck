(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/verdict/api';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (x) => Number(x || 0).toLocaleString('fr-FR');
  const when = (iso) => iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const size = (b) => b == null ? '—' : b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(2)} Mo`;
  const TYPE = { file: 'Fichier', url: 'URL', domain: 'Domaine', ip: 'Adresse IP' };
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  let report = null, view = 'detections', hasKey = true;

  // ---- recent lookups (browser only) ----
  const RECENT = 'deck.verdict.recent';
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } };
  const remember = (q) => { try { localStorage.setItem(RECENT, JSON.stringify([q, ...recent().filter((x) => x !== q)].slice(0, 8))); } catch {} renderRecent(); };
  function renderRecent() {
    $('recent').innerHTML = recent().map((q) => `<button type="button" title="${esc(q)}">${esc(q)}</button>`).join('');
    $('recent').querySelectorAll('button').forEach((b) => b.onclick = () => { $('q').value = b.title; lookup(b.title); });
  }
  renderRecent();

  fetch(`${api}/status`).then((r) => r.json()).then((s) => {
    hasKey = !!s.vt_key;
    if (!hasKey) {
      $('key-note').innerHTML = 'Aucune clé VirusTotal n\'est configurée : ajoute <code>VT_API_KEY</code> au conteneur (clé gratuite sur virustotal.com).';
      $('go').disabled = true; $('pick').disabled = true;
    } else $('key-note').textContent = 'API VirusTotal v3. Clé gratuite : 4 requêtes par minute, 500 par jour ; les rapports sont mis en cache dix minutes.';
  }).catch(() => {});

  async function call(url, init) {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || body.detail || r.statusText);
    return body;
  }

  // ---- lookup ----
  async function lookup(q) {
    q = q.trim();
    if (!q) return;
    status('Interrogation de VirusTotal…', 'busy'); $('go').disabled = true;
    try {
      const out = await call(`${api}/lookup?q=${encodeURIComponent(q)}`);
      remember(q);
      show(out);
      status('');
    } catch (err) { status('Impossible : ' + err.message, 'err'); }
    finally { $('go').disabled = !hasKey; }
  }
  $('form').onsubmit = (e) => { e.preventDefault(); lookup($('q').value); };

  // ---- submit an unknown URL, then poll ----
  async function submitUrl(url) {
    status('URL soumise, analyse en cours…', 'busy');
    try {
      const s = await call(`${api}/scan/url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      await poll(s.analysis_id);
      const out = await call(`${api}/lookup?q=${encodeURIComponent(s.query)}`);
      show(out); status('');
    } catch (err) { status('Impossible : ' + err.message, 'err'); }
  }
  async function poll(id, tries = 20) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, i < 3 ? 4000 : 8000));
      const a = await call(`${api}/analysis/${encodeURIComponent(id)}`);
      status(`Analyse ${a.status === 'completed' ? 'terminée' : 'en cours'}… (${i + 1})`, 'busy');
      if (a.status === 'completed') return a;
    }
    throw new Error('l\'analyse prend plus de temps que prévu, réessaie le hash dans une minute');
  }

  // ---- file upload ----
  async function sendFile(file) {
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) { status('32 Mo maximum via l\'API publique.', 'err'); return; }
    status(`Envoi de ${file.name} (${size(file.size)})…`, 'busy');
    const fd = new FormData(); fd.append('file', file, file.name);
    try {
      const s = await call(`${api}/scan/file`, { method: 'POST', body: fd });
      if (s.known) { remember(s.query); show(s.report); status('Fichier déjà connu de VirusTotal : rapport existant, rien n\'a été envoyé.'); return; }
      status('Fichier envoyé, analyse en cours (souvent une à deux minutes)…', 'busy');
      await poll(s.analysis_id, 30);
      const out = await call(`${api}/lookup?q=${s.query}`);
      remember(s.query); show(out); status('');
    } catch (err) { status('Impossible : ' + err.message, 'err'); }
  }
  $('pick').onclick = () => $('file').click();
  $('file').onchange = () => { sendFile($('file').files[0]); $('file').value = ''; };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) sendFile(f); else { const t = e.dataTransfer.getData('text'); if (t) { $('q').value = t.trim(); lookup(t); } } });
  document.addEventListener('paste', (e) => { const f = e.clipboardData.files[0]; if (f && e.target.tagName !== 'INPUT') sendFile(f); });

  // ---- rendering ----
  function level(r) {
    if (!r.found) return 'none';
    const m = r.stats.malicious, s = r.stats.suspicious;
    return m >= 3 ? 'bad' : m + s > 0 ? 'warn' : 'ok';
  }
  const LABEL = { ok: 'sain', warn: 'suspect', bad: 'malveillant', none: 'inconnu' };

  function show(r) {
    report = r; view = 'detections';
    $('report').hidden = false;
    const lv = level(r);
    $('verdict').className = 'verdict panel ' + lv;
    if (!r.found) {
      $('verdict').innerHTML = `<div class="gauge"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="42"/></svg><div class="num">?</div></div>
        <div><span class="type-badge">${TYPE[r.type]}</span><h2><span class="label">inconnu</span></h2><div class="q">${esc(r.query)}</div><div class="line">${esc(r.hint)}</div>
        <div class="actions">${r.can_submit ? `<button class="btn primary small" id="submit-url">Soumettre l'URL</button>` : ''}${r.type === 'file' ? '<span class="dim">Le dépôt de fichier est juste au-dessus.</span>' : ''}</div></div>`;
      if (r.can_submit) $('submit-url').onclick = () => submitUrl(r.query);
      $('details').innerHTML = ''; $('engines-block').hidden = true;
      return;
    }
    const det = r.stats.malicious + r.stats.suspicious;
    // Ring: share of engines that flagged it; a clean result fills the ring in green instead of showing nothing.
    const pct = !r.total ? 0 : det ? Math.max(det / r.total, 0.03) : 1;
    const dash = 2 * Math.PI * 42;
    const title = r.type === 'file' ? (r.meta.names[0] || r.query) : r.type === 'url' ? (r.meta.title || r.query) : r.query;
    $('verdict').innerHTML = `
      <div class="gauge"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="42"/><circle class="bar" cx="50" cy="50" r="42" stroke-dasharray="${dash}" stroke-dashoffset="${dash * (1 - pct)}"/></svg>
        <div class="num">${det}<small>sur ${r.total}</small></div></div>
      <div>
        <span class="type-badge">${TYPE[r.type]}</span>
        <h2><span class="label">${LABEL[lv]}</span>${esc(title)}</h2>
        ${title !== r.query ? `<div class="q">${esc(r.query)}</div>` : ''}
        <div class="line">${det ? `${det} moteur${det > 1 ? 's' : ''} sur ${r.total} signale${det > 1 ? 'nt' : ''} cet élément` : `aucun des ${r.total} moteurs ne signale cet élément`}${r.meta.threat_label ? ` · classification <strong>${esc(r.meta.threat_label)}</strong>` : ''} · dernière analyse ${when(r.last_analysis)}</div>
        <div class="line">Réputation communautaire ${r.reputation ?? 0} · votes : ${r.votes.malicious} malveillant, ${r.votes.harmless} sain</div>
        <div class="stat-row">
          <div class="stat bad"><b>${r.stats.malicious}</b><span>malveillant</span></div><div class="stat warn"><b>${r.stats.suspicious}</b><span>suspect</span></div>
          <div class="stat ok"><b>${r.stats.harmless}</b><span>sain</span></div><div class="stat"><b>${r.stats.undetected}</b><span>sans avis</span></div><div class="stat"><b>${r.stats.timeout}</b><span>timeout</span></div>
        </div>
        <div class="actions">
          <a class="btn small" href="${esc(r.permalink)}" target="_blank" rel="noopener">Voir sur VirusTotal</a>
          <button class="btn small" id="copy-json" type="button">Copier le JSON</button>
          <div class="chips">${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        </div>
      </div>`;
    $('copy-json').onclick = () => navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(() => status('Rapport copié.'), () => status('Copie impossible.', 'err'));
    renderDetails(r);
    $('engines-block').hidden = false;
    renderEngines();
  }

  const link = (u) => `<a class="trunc mono" href="${esc(u)}" title="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`;
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v, mode]) => `<dt>${esc(k)}</dt><dd class="${mode === 1 ? 'mono' : ''}">${mode === 'url' ? link(v) : Array.isArray(v) ? v.map(esc).join('<br>') : esc(v)}</dd>`).join('')}</dl>`;
  const card = (title, body) => body ? `<section class="card panel"><h3>${esc(title)}</h3>${body}</section>` : '';
  const chips = (list, cls = '') => list && list.length ? `<div class="chips">${list.map((c) => `<span class="chip ${cls}">${esc(c)}</span>`).join('')}</div>` : '';

  function renderDetails(r) {
    const m = r.meta;
    const cats = Object.entries(r.categories || {});
    const catCard = cats.length ? card('Catégories', kv(cats)) : '';
    let cards = [];
    if (r.type === 'file') {
      cards.push(card('Fichier', kv([['Noms vus', m.names], ['Taille', size(m.size)], ['Type', m.type], ['Magic', m.magic], ['Signé par', m.signed_by], ['Première vue', when(m.first_seen)], ['Dernière vue', when(m.last_seen)], ['Soumissions', m.times_submitted]])));
      cards.push(card('Empreintes', kv([['SHA-256', m.sha256, 1], ['SHA-1', m.sha1, 1], ['MD5', m.md5, 1]])));
      if (m.threat_label || m.threat_categories.length || m.threat_names.length) cards.push(card('Menace', `${m.threat_label ? `<div class="q mono">${esc(m.threat_label)}</div>` : ''}${chips(m.threat_categories, 'hot')}${chips(m.threat_names, 'warn')}${chips(m.type_tags, 'teal')}`));
    } else if (r.type === 'url') {
      cards.push(card('Page', kv([['Titre', m.title], ['URL finale', m.final_url !== r.query ? m.final_url : null, 'url'], ['Code HTTP', m.http_code], ['Type', m.content_type], ['Taille', size(m.content_length)], ['Première vue', when(m.first_seen)], ['Dernière vue', when(m.last_seen)], ['Soumissions', m.times_submitted]])));
      if (m.threat_names.length) cards.push(card('Menaces nommées', chips(m.threat_names, 'hot')));
      if (m.redirects.length > 1) cards.push(card('Redirections', `<div class="dns">${m.redirects.map((u, i) => `<div><span>${i + 1}.</span><a href="${esc(u)}" title="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></div>`).join('')}</div>`));
      cards.push(catCard);
    } else if (r.type === 'domain') {
      cards.push(card('Domaine', kv([['Registrar', m.registrar], ['Créé le', when(m.created)], ['Mis à jour', when(m.updated)], ['Expire', when(m.expires)], ...Object.entries(m.popularity || {}).map(([k, v]) => [`Rang ${k}`, n(v)])])));
      if (m.dns.length) cards.push(card('DNS', `<div class="dns">${m.dns.map((d) => `<div><span>${esc(d.type)}</span>${esc(d.value)}</div>`).join('')}</div>`));
      cards.push(catCard);
      if (m.whois) cards.push(card('Whois', `<pre>${esc(m.whois)}</pre>`));
    } else if (r.type === 'ip') {
      cards.push(card('Adresse', kv([['Propriétaire', m.owner], ['AS', m.asn ? 'AS' + m.asn : null], ['Réseau', m.network, 1], ['Pays', m.country], ['Continent', m.continent], ['Registre', m.rir]])));
      cards.push(catCard);
      if (m.whois) cards.push(card('Whois', `<pre>${esc(m.whois)}</pre>`));
    }
    $('details').innerHTML = cards.filter(Boolean).join('');
  }

  function renderEngines() {
    if (!report || !report.found) return;
    const q = $('engine-filter').value.trim().toLowerCase();
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    let list = report.engines;
    if (view === 'detections') list = list.filter((e) => e.category === 'malicious' || e.category === 'suspicious');
    if (q) list = list.filter((e) => (e.engine + ' ' + e.result).toLowerCase().includes(q));
    $('engines-title').textContent = `Moteurs · ${list.length}${view === 'detections' ? ' détection' + (list.length > 1 ? 's' : '') : ''}`;
    $('engines').innerHTML = list.map((e) => `<div class="eng ${esc(e.category)}" title="${esc(e.method || '')} ${esc(e.version || '')}"><span class="dot"></span><div><div class="name">${esc(e.engine)}</div><div class="res">${esc(e.result || (e.category === 'undetected' ? 'sans avis' : e.category))}</div></div><span class="upd">${esc(e.update || '')}</span></div>`).join('')
      || `<p class="empty">${view === 'detections' ? 'Aucune détection. Tous les moteurs sont dans l\'onglet « Tous ».' : 'Rien ne correspond.'}</p>`;
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { view = b.dataset.view; renderEngines(); });
  $('engine-filter').addEventListener('input', renderEngines);

  // ?q= from the shell, or a hash pasted anywhere
  const initial = new URLSearchParams(location.search).get('q');
  if (initial) { $('q').value = initial; lookup(initial); }
})();
