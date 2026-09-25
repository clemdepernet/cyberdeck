(() => {
  const $ = (id) => document.getElementById(id);
  const status = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  let parsed, hasParsed = false;

  const indentValue = () => ($('indent').value === 'tab' ? '\t' : Number($('indent').value));

  // ---- parsing with a useful error position ----
  // Browsers word their errors differently: Chrome gives "at position N" (and
  // lately "(line L column C)"), Firefox "at line L column C". Take whichever
  // is there and derive the rest.
  function locate(text, message) {
    let pos = null, line = null, col = null;
    const p = /position (\d+)/.exec(message);
    const lc = /line (\d+) column (\d+)/.exec(message);
    if (p) pos = +p[1];
    if (lc) { line = +lc[1]; col = +lc[2]; }
    if (pos !== null && line === null) {
      const before = text.slice(0, pos);
      line = before.split('\n').length;
      col = pos - before.lastIndexOf('\n');
    } else if (pos === null && line !== null) {
      const lines = text.split('\n');
      pos = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
    }
    return pos === null ? null : { pos, line, col };
  }
  function parse(text) {
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (e) {
      const message = e.message.replace(/^JSON\.parse: /, '').replace(/\s*\(line \d+ column \d+\)/, '').replace(/ at line \d+ column \d+( of the JSON data)?/, '').replace(/ in JSON at position \d+/, '').replace(/ at position \d+/, '');
      return { ok: false, error: message, loc: locate(text, e.message) };
    }
  }
  function goTo(loc) {
    const ta = $('input');
    ta.focus();
    ta.setSelectionRange(loc.pos, Math.min(loc.pos + 1, ta.value.length));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (loc.line - 3) * lh);
  }

  // ---- lenient repair: comments, single quotes, unquoted keys, trailing commas, python literals ----
  function repair(text) {
    let s = text.trim();
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');   // comments
    s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    s = s.replace(/\bNaN\b/g, 'null').replace(/\b-?Infinity\b/g, 'null').replace(/\bundefined\b/g, 'null');
    // single-quoted strings -> double-quoted (outside double-quoted strings)
    let out = '', inD = false, inS = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i], prev = s[i - 1];
      if (inD) { out += c; if (c === '"' && prev !== '\\') inD = false; continue; }
      if (inS) { if (c === "'" && prev !== '\\') { inS = false; out += '"'; } else if (c === '"') out += '\\"'; else if (c === '\\' && s[i + 1] === "'") { out += "'"; i++; } else out += c; continue; }
      if (c === '"') { inD = true; out += c; }
      else if (c === "'") { inS = true; out += '"'; }
      else out += c;
    }
    s = out;
    s = s.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":');   // unquoted keys
    s = s.replace(/,\s*([}\]])/g, '$1');                             // trailing commas
    s = s.replace(/}\s*{/g, '},{');                                  // concatenated objects
    if (/^\s*{[\s\S]*}\s*,\s*{[\s\S]*}\s*$/.test(s)) s = '[' + s + ']';
    return s;
  }

  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => a.localeCompare(b)).reduce((o, k) => (o[k] = sortKeys(v[k]), o), {});
    return v;
  }

  // ---- stats ----
  function stats(v, depth = 0, acc = { keys: 0, depth: 0, arrays: 0, objects: 0, strings: 0, numbers: 0, nulls: 0, bools: 0 }) {
    acc.depth = Math.max(acc.depth, depth);
    if (Array.isArray(v)) { acc.arrays++; v.forEach((x) => stats(x, depth + 1, acc)); }
    else if (v && typeof v === 'object') { acc.objects++; for (const k in v) { acc.keys++; stats(v[k], depth + 1, acc); } }
    else if (typeof v === 'string') acc.strings++;
    else if (typeof v === 'number') acc.numbers++;
    else if (typeof v === 'boolean') acc.bools++;
    else acc.nulls++;
    return acc;
  }

  // ---- tree rendering ----
  function render(v, key, root) {
    const node = document.createElement('div');
    node.className = 'node' + (root ? ' root' : '');
    const row = document.createElement('div');
    row.className = 'row';
    node.appendChild(row);
    const isObj = v && typeof v === 'object';
    if (isObj) {
      const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
      const tog = document.createElement('span');
      tog.className = 'tog'; tog.textContent = '▾';
      tog.onclick = () => { node.classList.toggle('folded'); tog.textContent = node.classList.contains('folded') ? '▸' : '▾'; };
      row.appendChild(tog);
      if (key !== undefined) row.insertAdjacentHTML('beforeend', `<span class="k">${esc(JSON.stringify(String(key)))}</span><span class="p">: </span>`);
      row.insertAdjacentHTML('beforeend', `<span class="p">${Array.isArray(v) ? '[' : '{'}</span><span class="count">${keys.length} ${Array.isArray(v) ? 'élément' : 'clé'}${keys.length > 1 ? 's' : ''}</span>`);
      for (const k of keys) node.appendChild(render(v[k], k, false));
      const close = document.createElement('div');
      close.className = 'row p'; close.textContent = Array.isArray(v) ? ']' : '}';
      node.appendChild(close);
      if (keys.length > 60 && !root) { node.classList.add('folded'); tog.textContent = '▸'; }
    } else {
      row.insertAdjacentHTML('beforeend', '<span class="tog"></span>' + (key !== undefined ? `<span class="k">${esc(JSON.stringify(String(key)))}</span><span class="p">: </span>` : '') + leaf(v));
    }
    node.dataset.key = key === undefined ? '' : String(key);
    return node;
  }
  function leaf(v) {
    if (v === null) return '<span class="z">null</span>';
    if (typeof v === 'string') return `<span class="s">${esc(JSON.stringify(v))}</span>`;
    if (typeof v === 'number') return `<span class="n">${v}</span>`;
    return `<span class="b">${v}</span>`;
  }

  function show(value, msg) {
    parsed = value; hasParsed = true;
    const st = stats(value);
    const text = JSON.stringify(value, null, indentValue());
    $('tree').innerHTML = '';
    $('tree').appendChild(render(value, undefined, true));
    $('text').textContent = text;
    $('stats').textContent = `${st.keys} clé${st.keys > 1 ? 's' : ''} · profondeur ${st.depth} · ${st.objects} objet${st.objects > 1 ? 's' : ''}, ${st.arrays} tableau${st.arrays > 1 ? 'x' : ''} · ${(new Blob([text]).size / 1024).toFixed(1)} Ko indenté`;
    $('verdict').textContent = msg || 'JSON valide.';
    $('verdict').className = 'verdict ok';
  }
  function fail(err, loc) {
    hasParsed = false;
    const v = $('verdict');
    v.className = 'verdict err';
    if (!loc) { v.textContent = 'JSON invalide : ' + err; $('stats').textContent = ''; return; }
    const lineText = $('input').value.split('\n')[loc.line - 1] || '';
    const from = Math.max(0, loc.col - 41);
    const shown = lineText.slice(from, from + 80);
    const caret = ' '.repeat(Math.max(0, loc.col - 1 - from)) + '^';
    v.innerHTML = `<span class="where">Ligne ${loc.line}, colonne ${loc.col}</span> : ${esc(err)} <button class="btn small goto" type="button">Aller à la ligne ${loc.line}</button>
      <pre class="snippet mono">${esc(from ? '…' + shown : shown)}\n${from ? ' ' : ''}${caret}</pre>`;
    v.querySelector('.goto').onclick = () => goTo(loc);
    $('stats').textContent = '';
  }

  let timer;
  function analyse(quiet) {
    const text = $('input').value;
    if (!text.trim()) { $('verdict').textContent = 'Colle du JSON pour commencer.'; $('verdict').className = 'verdict'; $('tree').innerHTML = ''; $('text').textContent = ''; $('stats').textContent = ''; hasParsed = false; return null; }
    const r = parse(text);
    if (r.ok) { show(r.value); return r.value; }
    fail(r.error, r.loc);
    if (!quiet) status('Le bouton « Réparer » tolère quotes simples, virgules finales, commentaires et clés nues.', '');
    return null;
  }
  $('input').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => analyse(true), 250); });

  $('format').onclick = () => { const v = analyse(); if (v !== null) { $('input').value = JSON.stringify(v, null, indentValue()); status('Indenté.', 'ok'); } };
  $('minify').onclick = () => { const v = analyse(); if (v !== null) { $('input').value = JSON.stringify(v); status(`Compacté : ${$('input').value.length.toLocaleString('fr-FR')} caractères.`, 'ok'); } };
  $('sort').onclick = () => { const v = analyse(); if (v !== null) { const s = sortKeys(v); $('input').value = JSON.stringify(s, null, indentValue()); show(s, 'Clés triées, JSON valide.'); status('Clés triées récursivement.', 'ok'); } };
  $('repair').onclick = () => {
    const fixed = repair($('input').value);
    const r = parse(fixed);
    if (r.ok) { $('input').value = JSON.stringify(r.value, null, indentValue()); show(r.value, 'Réparé et valide.'); status('Réparation réussie.', 'ok'); }
    else { $('input').value = fixed; fail(r.error, r.loc); status('Réparation partielle : il reste une erreur, voir ci-dessus.', 'err'); }
  };
  $('unescape').onclick = () => {
    // A JSON string containing JSON (log lines, API bodies): unwrap one level.
    let text = $('input').value.trim();
    try {
      if (text.startsWith('"')) text = JSON.parse(text);
      else text = text.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      $('input').value = text; analyse(); status('Un niveau d\'échappement retiré.', 'ok');
    } catch (e) { status('Impossible de dé-échapper : ' + e.message, 'err'); }
  };
  $('indent').onchange = () => { if (hasParsed) show(parsed); };
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('input').value); status('Copié.', 'ok'); } catch { status('Copie impossible.', 'err'); } };
  $('download').onclick = () => {
    const blob = new Blob([$('input').value], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'data.json' });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('clear').onclick = () => { $('input').value = ''; analyse(true); status(''); };

  document.querySelectorAll('.tabs .btn').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tabs .btn').forEach((x) => x.classList.toggle('active', x === b));
    $('tree').hidden = b.dataset.tab !== 'tree'; $('text').hidden = b.dataset.tab !== 'text';
  });
  $('expand').onclick = () => $('tree').querySelectorAll('.node.folded').forEach((n) => { n.classList.remove('folded'); n.querySelector('.tog').textContent = '▾'; });
  $('collapse').onclick = () => $('tree').querySelectorAll('.node:not(.root)').forEach((n) => { if (n.querySelector(':scope > .node')) { n.classList.add('folded'); n.querySelector('.tog').textContent = '▸'; } });

  // Path query: data.items[0].id → highlights and reveals the node.
  $('query').addEventListener('input', () => {
    $('tree').querySelectorAll('.hit').forEach((n) => n.classList.remove('hit'));
    const q = $('query').value.trim();
    if (!q || !hasParsed) return;
    const parts = q.replace(/\[(\d+)\]/g, '.$1').replace(/^\$\.?/, '').split('.').filter(Boolean);
    let node = $('tree').querySelector('.node.root');
    for (const p of parts) {
      node = [...node.children].find((c) => c.classList && c.classList.contains('node') && c.dataset.key === p);
      if (!node) { status(`Chemin introuvable à « ${p} ».`, 'err'); return; }
    }
    let n = node;
    while (n && n !== $('tree')) { n.classList.remove('folded'); const t = n.querySelector(':scope > .row .tog'); if (t && t.textContent) t.textContent = '▾'; n = n.parentElement; }
    node.classList.add('hit');
    node.scrollIntoView({ block: 'center' });
    status('');
  });

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
