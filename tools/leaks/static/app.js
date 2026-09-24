(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/leaks/api';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  const n = (x) => Number(x || 0).toLocaleString('fr-FR');
  const day = (iso) => iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const rel = (iso) => {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso)) / 864e5;
    return d < 1 ? "aujourd'hui" : d < 2 ? 'hier' : d < 30 ? `il y a ${Math.floor(d)} j` : day(iso);
  };
  const HOT = /password|mot de passe|iban|bank|credit|carte|social security|passport|identit|health|medical|sant/i;
  let result = null, view = 'all', feedData = null, feedTab = 'french';

  fetch(`${api}/status`).then((r) => r.json()).then((s) => {
    if (!s.hibp_key) {
      $('key-note').innerHTML = 'Aucune clé HIBP n\'est configurée : la recherche par e-mail est désactivée. Le fil d\'actualité et le test de mot de passe marchent sans. Ajoute <code>HIBP_API_KEY</code> au conteneur pour l\'activer.';
      $('check-btn').disabled = true;
    } else $('key-note').textContent = 'Recherche via l\'API Have I Been Pwned v3, bases vérifiées et non vérifiées incluses.';
  }).catch(() => {});

  // ---- e-mail ----
  $('check-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    status('Recherche…'); $('check-btn').disabled = true;
    try {
      const r = await fetch(`${api}/check?email=${encodeURIComponent(email)}`);
      const out = await r.json();
      if (!r.ok) throw new Error(out.detail || out.error || r.statusText);
      result = out; view = 'all';
      render();
      status('');
    } catch (err) {
      status('Impossible : ' + err.message, 'err');
    } finally { $('check-btn').disabled = false; }
  };

  function render() {
    const b = result.breaches, fr = result.french;
    $('result').hidden = false;
    const bad = b.length > 0;
    $('verdict').className = 'verdict panel ' + (bad ? 'bad' : 'ok');
    $('verdict').innerHTML = `<span class="big ${bad ? 'bad' : 'ok'}">${b.length}</span><div><strong>${esc(result.email)}</strong><br><span class="muted">${bad
      ? `présente dans ${b.length} fuite${b.length > 1 ? 's' : ''}${fr.length ? `, dont ${fr.length} française${fr.length > 1 ? 's' : ''}` : ''} · ${result.data_classes.length} types de données exposés`
      : 'aucune fuite connue de HIBP pour cette adresse'}</span></div>`;
    document.querySelectorAll('#result-tabs .btn').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
    if (view === 'classes') {
      $('breaches').innerHTML = `<div class="panel classes">${result.data_classes.map((c) => `<span class="chip ${HOT.test(c) ? 'hot' : ''}">${esc(c)}</span>`).join('') || '<span class="dim">rien</span>'}</div>`;
    } else {
      const list = view === 'fr' ? fr : b;
      $('breaches').innerHTML = list.map((x) => `
        <article class="breach panel">
          ${x.logo ? `<img src="${esc(x.logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:${JSON.stringify(x.title[0] || '?')}}))">` : `<div class="placeholder">${esc(x.title[0] || '?')}</div>`}
          <div>
            <div class="breach-head"><h3><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="dim">${esc(x.domain)}</span></h3><span class="when">fuite ${day(x.breach_date)} · ${n(x.pwn_count)} comptes</span></div>
            <p>${esc(x.description)}</p>
            <div class="chips">${x.french ? '<span class="chip fr">France</span>' : ''}${x.sensitive ? '<span class="chip warn">sensible</span>' : ''}${x.stealer_log ? '<span class="chip hot">infostealer</span>' : ''}${!x.verified ? '<span class="chip">non vérifiée</span>' : ''}${x.data_classes.map((c) => `<span class="chip ${HOT.test(c) ? 'hot' : ''}">${esc(c)}</span>`).join('')}</div>
          </div>
        </article>`).join('') || '<p class="dim">Rien dans cette vue.</p>';
    }
    $('pastes').hidden = !result.pastes.length;
    if (result.pastes.length) $('pastes').innerHTML = `<h2>Pastes (${result.pastes.length})</h2>` + result.pastes.map((p) => `<div class="muted">${esc(p.source)} · ${esc(p.title || p.id)} · ${day(p.date)} · ${n(p.count)} adresses</div>`).join('');
  }
  document.querySelectorAll('#result-tabs .btn').forEach((b) => b.onclick = () => { view = b.dataset.view; render(); });

  // ---- password ----
  async function sha1(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  $('pwd-btn').onclick = async () => {
    const pwd = $('pwd').value;
    if (!pwd) return;
    const out = $('pwd-result'); out.textContent = 'Calcul…'; out.className = '';
    try {
      const h = await sha1(pwd);
      const r = await fetch(`${api}/password-range/${h.slice(0, 5)}`);
      const d = await r.json();
      const count = d.suffixes[h.slice(5)];
      if (count) { out.textContent = `Vu ${n(count)} fois dans des fuites. À changer partout où il est utilisé.`; out.className = 'bad'; }
      else { out.textContent = 'Inconnu des bases Pwned Passwords. Ça ne veut pas dire fort, juste pas encore fuité.'; out.className = 'ok'; }
    } catch { out.textContent = 'Service indisponible.'; out.className = 'bad'; }
    $('pwd').value = '';
  };
  $('pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('pwd-btn').click(); } });

  // ---- feed ----
  async function loadFeed() {
    try {
      const r = await fetch(`${api}/feed`);
      feedData = await r.json();
      renderFeed();
    } catch { $('feed-meta').textContent = 'Fil indisponible.'; }
  }
  function renderFeed() {
    if (!feedData) return;
    const q = $('feed-filter').value.trim().toLowerCase();
    const list = (feedData[feedTab] || []).filter((i) => !q || (i.title + ' ' + i.summary + ' ' + (i.tags || []).join(' ')).toLowerCase().includes(q));
    document.querySelectorAll('[data-feed]').forEach((b) => b.classList.toggle('active', b.dataset.feed === feedTab));
    $('feed-meta').textContent = `${list.length} entrées · sources : ${feedData.sources.join(', ')}${feedData.errors.length ? ' · indisponibles : ' + feedData.errors.map((e) => e.split(':')[0]).join(', ') : ''} · actualisé ${rel(feedData.fetched_at)}`;
    $('feed-list').innerHTML = list.map((i) => `
      <a class="item" href="${esc(i.link)}" target="_blank" rel="noopener">
        <div class="item-top"><span class="src ${i.source === 'Bonjour la fuite' ? 'blf' : ''}">${esc(i.source)}</span><span>${rel(i.date)}</span></div>
        <div class="item-title">${esc(i.title)}</div>
        ${i.details && i.details.length ? `<div class="chips">${i.details.map((d) => `<span class="chip ${HOT.test(d) ? 'hot' : ''}">${esc(d)}</span>`).join('')}</div>` : i.summary ? `<div class="item-sum">${esc(i.summary)}</div>` : ''}
        ${i.breach && i.breach.data_classes.length && !(i.details && i.details.length) ? `<div class="chips">${i.breach.data_classes.slice(0, 5).map((d) => `<span class="chip ${HOT.test(d) ? 'hot' : ''}">${esc(d)}</span>`).join('')}</div>` : ''}
      </a>`).join('') || '<p class="dim" style="padding:14px">Rien ne correspond.</p>';
  }
  document.querySelectorAll('[data-feed]').forEach((b) => b.onclick = () => { feedTab = b.dataset.feed; renderFeed(); });
  $('feed-filter').addEventListener('input', renderFeed);
  loadFeed();
  setInterval(loadFeed, 15 * 60 * 1000);
})();
