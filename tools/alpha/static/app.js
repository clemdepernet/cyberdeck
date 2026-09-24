(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/alpha/api/images';
  const status = (msg, kind = '') => { $('status').textContent = msg; $('status').className = 'status ' + kind; };
  let image = null;       // server info for the current image
  let view = { mode: 'original', channel: 'a', bit: 0 };
  let zoom = 1;
  let lsbData = null;

  // ---- upload ----
  async function upload(file) {
    if (!file) return;
    status('Analyse de ' + file.name + '…');
    const fd = new FormData();
    fd.append('file', file, file.name || 'clipboard.png');
    try {
      const r = await fetch(api, { method: 'POST', body: fd });
      const out = await r.json();
      if (!r.ok) throw new Error(out.detail || r.statusText);
      image = out;
      showInfo();
      $('work').hidden = false;
      $('forget').hidden = false;
      $('drop').classList.add('compact');
      setView({ mode: 'original' }, true);
      $('lsb-out').hidden = true;
      status('');
    } catch (e) {
      status('Impossible d\'analyser : ' + e.message, 'err');
    }
  }

  function showInfo() {
    const a = image.alpha, total = image.width * image.height;
    $('info-name').textContent = image.name || 'image';
    const rows = [
      ['Dimensions', `${image.width} × ${image.height} px (${total.toLocaleString('fr-FR')} px)`],
      ['Format', `${image.format} · mode ${image.mode} · ${(image.bytes / 1024).toFixed(1)} Ko`],
      ['Canal alpha', image.has_alpha ? 'présent' : 'absent (image opaque)'],
      ['Alpha', `min ${a.min} · max ${a.max} · ${a.unique_values} valeur${a.unique_values > 1 ? 's' : ''}`],
      ['Transparents', `${a.transparent_pixels.toLocaleString('fr-FR')} px (${(100 * a.transparent_pixels / total).toFixed(1)} %)`],
      ['Partiels', `${a.partial_pixels.toLocaleString('fr-FR')} px`],
      ['R / V / B', ['r', 'g', 'b'].map((c) => `${image.channels[c].unique_values}`).join(' / ') + ' valeurs'],
    ];
    for (const [k, v] of Object.entries(image.metadata || {})) rows.push([k, v]);
    $('info-kv').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const hid = image.hidden_in_transparent;
    const verdict = $('verdict');
    if (hid.pixels > 0 && hid.distinct_colors > 1) {
      verdict.textContent = `${hid.pixels.toLocaleString('fr-FR')} pixels transparents portent ${hid.distinct_colors.toLocaleString('fr-FR')} couleurs différentes : il y a probablement quelque chose caché sous l'alpha. Regarde « Alpha forcé opaque ».`;
      verdict.className = 'verdict hot';
    } else if (image.has_alpha && a.unique_values > 2 && a.partial_pixels > 0) {
      verdict.textContent = 'L\'alpha a des valeurs intermédiaires : vérifie le canal alpha et ses bit-planes bas.';
      verdict.className = 'verdict hot';
    } else if (!image.has_alpha) {
      verdict.textContent = 'Pas d\'alpha : concentre-toi sur les bit-planes RVB et l\'extraction LSB.';
      verdict.className = 'verdict';
    } else {
      verdict.textContent = 'Alpha uniforme ou binaire : rien d\'anormal en surface.';
      verdict.className = 'verdict';
    }
  }

  // ---- views ----
  function setView(v, fit) {
    view = { ...view, ...v };
    const q = new URLSearchParams({ mode: view.mode, channel: view.channel, bit: view.bit, invert: $('invert').checked });
    const url = `${api}/${image.id}/view?${q}`;
    $('img').src = url;
    $('download').href = url;
    $('download').download = `${(image.name || 'image').replace(/\.[^.]+$/, '')}_${view.mode}${view.mode === 'channel' || view.mode === 'bitplane' ? '_' + view.channel : ''}${view.mode === 'bitplane' ? view.bit : ''}.png`;
    document.querySelectorAll('.view').forEach((b) => b.classList.toggle('active', b.dataset.mode === view.mode && (view.mode !== 'channel' || b.dataset.channel === view.channel)));
    document.querySelectorAll('.plane').forEach((b) => b.classList.toggle('active', view.mode === 'bitplane' && b.dataset.channel === view.channel && +b.dataset.bit === view.bit));
    const labels = { original: 'Original', channel: { r: 'Canal rouge', g: 'Canal vert', b: 'Canal bleu', a: 'Canal alpha' }[view.channel], alpha_mask: 'Transparence : rouge = alpha 0, ambre = partiel', opaque: 'Alpha forcé à 255', lsb_amplified: 'Deux bits de poids faible, amplifiés', bitplane: `Bit-plane ${view.channel.toUpperCase()}${view.bit}` };
    $('view-label').textContent = labels[view.mode] + ($('invert').checked ? ' · inversé' : '');
    if (fit) $('img').onload = () => { fitZoom(); $('img').onload = null; };
  }
  document.querySelectorAll('.view').forEach((b) => b.onclick = () => setView({ mode: b.dataset.mode, channel: b.dataset.channel || view.channel }));
  $('invert').onchange = () => setView({});

  const planes = $('planes');
  planes.innerHTML = '<span></span>' + [7, 6, 5, 4, 3, 2, 1, 0].map((b) => `<span class="lbl">${b}</span>`).join('') +
    ['r', 'g', 'b', 'a'].map((c) => `<span class="lbl">${c.toUpperCase()}</span>` + [7, 6, 5, 4, 3, 2, 1, 0].map((b) => `<button class="btn plane ${c}" data-channel="${c}" data-bit="${b}" title="${c.toUpperCase()} bit ${b}">${b}</button>`).join('')).join('');
  planes.querySelectorAll('.plane').forEach((b) => b.onclick = () => setView({ mode: 'bitplane', channel: b.dataset.channel, bit: +b.dataset.bit }));

  // ---- zoom ----
  function applyZoom() { $('img').style.width = (image.width * zoom) + 'px'; $('zoom').textContent = Math.round(zoom * 100) + ' %'; }
  function fitZoom() {
    const box = $('canvas').getBoundingClientRect();
    zoom = Math.min((box.width - 32) / image.width, (box.height - 32) / image.height, 8);
    if (zoom < 0.05) zoom = 0.05;
    applyZoom();
  }
  $('zoom-in').onclick = () => { zoom = Math.min(zoom * 1.5, 32); applyZoom(); };
  $('zoom-out').onclick = () => { zoom = Math.max(zoom / 1.5, 0.05); applyZoom(); };
  $('zoom-fit').onclick = fitZoom;

  // ---- LSB ----
  async function runLsb() {
    const ch = $('lsb-ch').value.toLowerCase().replace(/[^rgba]/g, '') || 'rgb';
    $('lsb-ch').value = ch;
    status('Extraction LSB…');
    try {
      const q = new URLSearchParams({ channels: ch, bits: $('lsb-bits').value, order: $('lsb-order').value, limit: 4096 });
      const r = await fetch(`${api}/${image.id}/lsb?${q}`);
      const out = await r.json();
      if (!r.ok) throw new Error(out.detail || r.statusText);
      lsbData = out;
      $('lsb-meta').textContent = `${out.total_bytes.toLocaleString('fr-FR')} octets extraits (${ch.toUpperCase()}, ${out.bits} bit${out.bits > 1 ? 's' : ''}, ${out.order === 'row' ? 'lignes' : 'colonnes'})` + (out.detected ? ` · signature détectée : ${out.detected.toUpperCase()}` : '') + ` · ${out.strings.length} chaîne${out.strings.length > 1 ? 's' : ''} lisible${out.strings.length > 1 ? 's' : ''}`;
      $('lsb-out').hidden = false;
      showTab('strings');
      status('');
    } catch (e) {
      status('Extraction impossible : ' + e.message, 'err');
    }
  }
  function showTab(name) {
    document.querySelectorAll('.tabs .btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (!lsbData) return;
    if (name === 'strings') $('lsb-pre').textContent = lsbData.strings.length ? lsbData.strings.join('\n') : '(aucune chaîne ASCII de 4 caractères ou plus)';
    else if (name === 'hex') $('lsb-pre').textContent = (lsbData.hex.match(/.{1,32}/g) || []).map((l, i) => (i * 16).toString(16).padStart(6, '0') + '  ' + l.replace(/(..)/g, '$1 ')).join('\n');
    else $('lsb-pre').textContent = lsbData.ascii;
  }
  $('lsb-run').onclick = runLsb;
  document.querySelectorAll('.tabs .btn').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  $('lsb-dl').onclick = () => {
    const q = new URLSearchParams({ channels: $('lsb-ch').value || 'rgb', bits: $('lsb-bits').value, order: $('lsb-order').value, raw: 'true' });
    window.open(`${api}/${image.id}/lsb?${q}`);
  };

  // ---- input plumbing ----
  $('browse').onclick = (e) => { e.stopPropagation(); $('file').click(); };
  $('drop').onclick = () => $('file').click();
  $('file').onchange = () => upload($('file').files[0]);
  ['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
  $('drop').addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) upload(item.getAsFile());
  });
  $('forget').onclick = async () => {
    if (image) await fetch(`${api}/${image.id}`, { method: 'DELETE' });
    image = null; lsbData = null;
    $('work').hidden = true; $('forget').hidden = true;
    status('Image oubliée côté serveur.');
  };
  window.addEventListener('resize', () => { if (image) fitZoom(); });

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
