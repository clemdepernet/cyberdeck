(() => {
  const $ = (id) => document.getElementById(id);
  const api = '/convert/api/files';
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  let current = null;

  const fmtSize = (n) => n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(1) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo';
  const catLabel = { image: 'Image', pdf: 'PDF', document: 'Document texte', html: 'Page HTML', markdown: 'Markdown', spreadsheet: 'Tableur', presentation: 'Présentation', audio: 'Audio', video: 'Vidéo' };

  // Show what the deck accepts, straight from the server matrix.
  fetch('/convert/api/formats').then((r) => r.json()).then((m) => {
    const groups = {};
    for (const ext of Object.keys(m).sort()) (groups[m[ext].category] = groups[m[ext].category] || []).push(ext);
    const order = ['document', 'spreadsheet', 'presentation', 'pdf', 'html', 'markdown', 'image', 'audio', 'video'];
    $('matrix').innerHTML = order.filter((c) => groups[c]).map((c) => `<span><b>${catLabel[c]}</b> ${groups[c].join(', ')}</span>`).join('');
  }).catch(() => {});

  async function upload(file) {
    if (!file) return;
    status(`Envoi de ${file.name} (${fmtSize(file.size)})…`);
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const r = await fetch(api, { method: 'POST', body: fd });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      current = out;
      show();
      status('');
    } catch (e) {
      status('Impossible : ' + e.message, 'err');
    }
  }

  function show() {
    $('drop').hidden = true;
    $('work').hidden = false;
    $('reset').hidden = false;
    $('history').innerHTML = '';
    $('file-ext').textContent = current.ext;
    $('file-name').textContent = `${current.name}.${current.ext}`;
    $('file-info').textContent = `${catLabel[current.category] || current.category} · ${fmtSize(current.size)} · choisis un format de sortie :`;
    const groups = {};
    for (const t of current.targets) (groups[t.group] = groups[t.group] || []).push(t);
    $('groups').innerHTML = Object.entries(groups).map(([g, ts]) => `<section class="group panel"><h3>${g}</h3><div class="targets">${ts.map((t) =>
      `<button class="btn target${t.ext === 'pdf' ? ' primary' : ''}" data-ext="${t.ext === 'gif' && t.group === 'Vidéo' ? 'gifv' : t.ext}">${t.label}${t.note ? `<small>${t.note}</small>` : ''}</button>`).join('')}</div></section>`).join('');
    $('groups').querySelectorAll('.target').forEach((b) => b.onclick = () => convert(b.dataset.ext, b.textContent));
  }

  async function convert(target, label) {
    $('progress').hidden = false;
    $('progress-text').textContent = `${current.name}.${current.ext} → ${label}…`;
    $('groups').querySelectorAll('.target').forEach((b) => b.disabled = true);
    const started = Date.now();
    try {
      const r = await fetch(`${api}/${current.id}/to/${target}`, { method: 'POST' });
      if (!r.ok) {
        let msg = r.statusText;
        try { msg = (await r.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd) || /filename="([^"]+)"/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : `${current.name}.${target}`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      addHistory(`${name} · ${fmtSize(blob.size)} · ${((Date.now() - started) / 1000).toFixed(1)} s`, false, a.href, name);
    } catch (e) {
      addHistory(`${label} : échec`, true, null, null, e.message);
    } finally {
      $('progress').hidden = true;
      $('groups').querySelectorAll('.target').forEach((b) => b.disabled = false);
    }
  }

  function addHistory(text, isErr, href, name, msg) {
    const div = document.createElement('div');
    div.className = 'done' + (isErr ? ' err' : '');
    div.innerHTML = `<span>${esc(text)}${msg ? `<br><span class="msg">${esc(msg)}</span>` : ''}</span>` + (href ? `<a class="btn small" href="${href}" download="${esc(name)}">Re-télécharger</a>` : '');
    $('history').prepend(div);
  }

  $('reset').onclick = async () => {
    if (current) fetch(`${api}/${current.id}`, { method: 'DELETE' }).catch(() => {});
    current = null;
    $('work').hidden = true; $('reset').hidden = true; $('drop').hidden = false; $('file').value = '';
    status('');
  };
  $('browse').onclick = (e) => { e.stopPropagation(); $('file').click(); };
  $('drop').onclick = () => $('file').click();
  $('file').onchange = () => upload($('file').files[0]);
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
  document.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) { if (current) $('reset').click(); upload(e.dataTransfer.files[0]); } });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
    if (item) { if (current) $('reset').click(); upload(item.getAsFile()); }
  });
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
