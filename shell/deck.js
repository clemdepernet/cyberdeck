// Optional helper for tool pages: forwards Alt+digit / Alt+0 to the shell so the
// keyboard shortcuts keep working while focus is inside a tool's iframe.
(() => {
  if (window.parent === window) return;
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === '0') { e.preventDefault(); window.parent.postMessage({ type: 'deck:toggle' }, '*'); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) { e.preventDefault(); window.parent.postMessage({ type: 'deck:switch', index: n - 1 }, '*'); }
  });
})();
