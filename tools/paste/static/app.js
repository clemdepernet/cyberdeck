(() => {
  const $ = (id) => document.getElementById(id);
  const status = (msg, kind = '') => { $('status').textContent = msg; $('status').className = 'status ' + kind; };
  const api = '/paste/api/pastes';
  let last = null;

  function mode(which) {
    $('send').hidden = which !== 'send';
    $('get').hidden = which !== 'get';
    $('mode-send').classList.toggle('active', which === 'send');
    $('mode-get').classList.toggle('active', which === 'get');
    status('');
    if (which === 'get') $('lookup').focus(); else $('content').focus();
  }
  $('mode-send').onclick = () => mode('send');
  $('mode-get').onclick = () => mode('get');

  $('content').addEventListener('input', () => {
    const n = $('content').value.length;
    $('count').textContent = n.toLocaleString('fr-FR') + (n > 1 ? ' caractères' : ' caractère');
  });

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); status(label + ' copié.', 'ok'); }
    catch { status('Copie impossible : sélectionne le texte à la main.', 'err'); }
  }

  $('create').onclick = async () => {
    const content = $('content').value;
    if (!content.trim()) { status('Rien à envoyer : la zone est vide.', 'err'); return; }
    $('create').disabled = true;
    status('Envoi…');
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ttl: $('ttl').value, burn: $('burn').checked }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      last = out;
      $('code').textContent = out.code;
      $('url').textContent = out.url;
      $('qr').src = `${api}/${out.code}/qr.png`;
      const exp = new Date(out.expires_at);
      $('expiry').textContent = (out.burn ? 'Détruit à la première lecture, au plus tard le ' : 'Expire le ') +
        exp.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) + '.';
      $('result').hidden = false;
      status('Code créé. Copie-le ou scanne le QR depuis l\'autre machine.', 'ok');
    } catch (e) {
      status('Échec : ' + e.message, 'err');
    } finally {
      $('create').disabled = false;
    }
  };
  $('code').onclick = () => last && copy(last.code, 'Code');
  $('copy-code').onclick = () => last && copy(last.code, 'Code');
  $('copy-url').onclick = () => last && copy(last.url, 'Lien');
  $('copy-curl').onclick = () => last && copy(`curl -s ${last.url}`, 'Commande curl');

  async function lookup(code) {
    code = (code || '').trim().toUpperCase();
    if (!code) return;
    $('lookup').value = code;
    status('Recherche…');
    $('found').hidden = true;
    try {
      const r = await fetch(`${api}/${encodeURIComponent(code)}`);
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      $('found-content').textContent = out.content;
      const created = new Date(out.created_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      $('found-meta').textContent = `${code} · créé le ${created}` + (out.burn ? ' · détruit maintenant que tu l\'as lu' : '');
      $('found').hidden = false;
      $('delete').hidden = !!out.burn;
      status('');
    } catch (e) {
      status('Aucun paste pour ' + code + ' : ' + e.message, 'err');
    }
  }
  $('fetch-form').onsubmit = (e) => { e.preventDefault(); lookup($('lookup').value); };
  $('copy-content').onclick = () => copy($('found-content').textContent, 'Contenu');
  $('delete').onclick = async () => {
    const code = $('lookup').value.trim().toUpperCase();
    const r = await fetch(`${api}/${code}`, { method: 'DELETE' });
    if (r.ok) { $('found').hidden = true; status(code + ' supprimé du serveur.', 'ok'); }
    else status('Suppression impossible.', 'err');
  };

  const params = new URLSearchParams(location.search);
  if (params.get('code')) { mode('get'); lookup(params.get('code')); }
  else mode('send');
})();
