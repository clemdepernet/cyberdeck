(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/mirage/api';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  const size = (b) => b == null ? null : b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(1)} Mo`;
  const STRENGTH = { proof: 'preuve', strong: 'indice fort', hint: 'indice', auth: 'origine', 'weak-auth': 'origine (faible)', weak: 'faible', info: 'info' };
  const KIND = { image: 'Image', video: 'Vidéo' };
  let limits = { max_image: 60 * 1048576, max_video: 300 * 1048576 };

  fetch(`${api}/status`).then((r) => r.json()).then((s) => {
    limits = s;
    $('key-note').textContent = s.score
      ? 'Preuves locales (Content Credentials, métadonnées, filigrane) puis score statistique Sightengine. Fichiers supprimés après analyse.'
      : 'Preuves locales uniquement : Content Credentials, marqueurs IPTC, métadonnées de générateurs, filigrane Stable Diffusion, empreinte caméra. Ajoute SIGHTENGINE_USER et SIGHTENGINE_SECRET au conteneur pour un score statistique en plus.';
  }).catch(() => {});

  async function send(file) {
    if (!file) return;
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv|avi|mts|3gp)$/i.test(file.name);
    const limit = isVideo ? limits.max_video : limits.max_image;
    if (file.size > limit) { status(`${size(limit)} maximum pour ${isVideo ? 'une vidéo' : 'une image'}.`, 'err'); return; }
    status(`Analyse de ${file.name} (${size(file.size)})${isVideo ? ', extraction d\'images…' : '…'}`, 'busy');
    const fd = new FormData(); fd.append('file', file, file.name || 'image.png');
    try {
      const r = await fetch(`${api}/analyse`, { method: 'POST', body: fd });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || r.statusText);
      show(out); status('');
    } catch (e) { status('Impossible : ' + e.message, 'err'); }
  }
  async function fetchUrl(url) {
    if (!url) return;
    status('Téléchargement et analyse…', 'busy'); $('url-btn').disabled = true;
    try {
      const r = await fetch(`${api}/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || r.statusText);
      show(out); status('');
    } catch (e) { status('Impossible : ' + e.message, 'err'); }
    finally { $('url-btn').disabled = false; }
  }

  $('pick').onclick = () => $('file').click();
  $('file').onchange = () => { send($('file').files[0]); $('file').value = ''; };
  $('url-form').onsubmit = (e) => { e.preventDefault(); fetchUrl($('url').value.trim()); };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) send(f);
    else { const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text'); if (/^https?:\/\//i.test(t || '')) { $('url').value = t.trim(); fetchUrl(t.trim()); } }
  });
  document.addEventListener('paste', (e) => { const f = e.clipboardData.files[0]; if (f && e.target.tagName !== 'INPUT') send(f); });

  const fact = (t) => t ? `<span class="fact">${esc(t)}</span>` : '';
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  const card = (title, body) => body && !/<dl class="kv"><\/dl>/.test(body) ? `<section class="card panel"><h3>${esc(title)}</h3>${body}</section>` : '';

  function show(r) {
    $('report').hidden = false;
    const f = r.file, v = r.verdict;
    $('verdict').className = 'verdict panel ' + v.level;
    $('verdict').innerHTML = `
      <div class="preview">${r.preview ? `<img src="${r.preview}" alt="">` : '<span class="none">pas d\'aperçu</span>'}</div>
      <div>
        <span class="type-badge">${KIND[r.kind] || r.kind}${r.kind === 'video' && r.frames ? ` · ${r.frames} images extraites` : ''}</span>
        <h2><span class="label">${esc(v.label)}</span></h2>
        <div class="name">${esc(f.name)}</div>
        <div class="summary">${esc(v.summary)}.</div>
        <div class="facts">${fact(f.type)}${fact(f.width && f.height ? `${f.width}×${f.height}` : '')}${fact(size(f.size))}${fact(f.duration ? `${Number(f.duration).toFixed(1)} s` : '')}${fact(f.software)}${fact(f.make || f.model ? [f.make, f.model].filter(Boolean).join(' ') : '')}${fact(f.created)}${r.score != null ? fact(`score IA ${Math.round(r.score * 100)} %`) : ''}</div>
      </div>`;
    $('signals').innerHTML = r.signals.map((s) => `<li class="signal ${esc(s.strength)}"><span class="strength">${STRENGTH[s.strength] || s.strength}</span><div><div class="title">${esc(s.title)}</div><div class="detail">${esc(s.detail)}</div></div></li>`).join('')
      || '<li class="empty">Rien : ni signature, ni métadonnée de générateur, ni filigrane connu, ni empreinte d\'appareil.</li>';
    const cards = [];
    if (r.c2pa) cards.push(card('Content Credentials', kv([['Signé par', r.c2pa.generator], ['Titre', r.c2pa.title], ['Actions', (r.c2pa.actions || []).join(', ')], ['Type de source', (r.c2pa.source_types || []).join(', ')], ['Logiciels', (r.c2pa.agents || []).join(', ')], ['Ingrédients', r.c2pa.ingredients], ['Signature', r.c2pa.valid ? 'vérifiée' : 'non vérifiée : ' + (r.c2pa.errors || []).join(', ')]])));
    cards.push(card('Fichier', kv([['Type', f.type], ['MIME', f.mime], ['Dimensions', f.width && f.height ? `${f.width}×${f.height}` : null], ['Taille', size(f.size)], ['Durée', f.duration ? `${Number(f.duration).toFixed(2)} s` : null], ['Images/s', f.fps], ['Codec', f.codec], ['Audio', f.audio], ['Logiciel', f.software], ['Créé le', f.created], ['Profil couleur', f.color_profile], ['GPS', f.gps ? 'présent' : null], ['Description', f.description]])));
    cards.push(card('Appareil', kv([['Marque', f.make], ['Modèle', f.model], ['Objectif', f.lens], ['Exposition', f.exposure ? `${f.exposure} s` : null], ['Ouverture', f.fnumber ? `f/${f.fnumber}` : null], ['ISO', f.iso], ['Focale', f.focal ? `${f.focal} mm` : null]])));
    $('details').innerHTML = cards.filter(Boolean).join('');
    $('raw').textContent = Object.entries(r.metadata || {}).map(([k, val]) => `${k.padEnd(40)} ${typeof val === 'object' ? JSON.stringify(val) : val}`).join('\n');
  }
})();
