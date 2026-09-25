import { getNodesBounds, getViewportForBounds } from '@xyflow/react';
import { toSvg } from 'html-to-image';
import { jsPDF } from 'jspdf';

const PAD = 48;

function readVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// html-to-image's own PNG path relies on img.decode(), which never settles in
// Chrome for SVGs that wrap a foreignObject. So we take its SVG and rasterise
// it ourselves through a plain <img> and a canvas.
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} trop long`)), ms))]);

function svgToPng(svgUrl, w, h, scale, background) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('rendu de l’image trop long')), 20000);
    img.onload = async () => {
      clearTimeout(timer);
      // Painting straight from onload can yield an empty foreignObject: give
      // Chrome a frame, and a bounded decode(), before drawing.
      await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        const c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        const ctx = c.getContext('2d');
        ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) { reject(e); }
    };
    img.onerror = () => { clearTimeout(timer); reject(new Error('rendu SVG impossible')); };
    img.src = svgUrl;
  });
}

async function render(nodes, { scale = 2, background } = {}) {
  const bounds = getNodesBounds(nodes);
  const w = Math.ceil(bounds.width + PAD * 2), h = Math.ceil(bounds.height + PAD * 2);
  const vp = getViewportForBounds(bounds, w, h, 1, 1, PAD);
  const el = document.querySelector('.react-flow__viewport');
  const bg = background || readVar('--bg', '#1b1d22');
  const opts = {
    width: w, height: h,
    style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
    filter: (n) => !(n.classList && (n.classList.contains('react-flow__minimap') || n.classList.contains('react-flow__controls') || n.classList.contains('react-flow__panel'))),
  };
  let svg;
  try { svg = await withTimeout(toSvg(el, opts), 15000, 'incorporation des polices'); }
  catch { svg = await toSvg(el, { ...opts, skipFonts: true }); }
  return { url: await svgToPng(svg, w, h, scale, bg), w, h };
}

function download(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

const safeName = (name) => (name || 'carte').replace(/[^\w\-àâäéèêëïîôöùûüç ]+/gi, '').trim().replace(/\s+/g, '-') || 'carte';

export async function exportPng(nodes, name) {
  const { url } = await render(nodes);
  download(url, `${safeName(name)}.png`);
}

export async function exportPdf(nodes, name) {
  const { url, w, h } = await render(nodes, { background: '#ffffff' });
  const header = 40;
  const pdf = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'px', format: [w, h + header], compress: true });
  pdf.setFontSize(14);
  pdf.setTextColor(30, 30, 30);
  pdf.text(name || 'Carte', 16, 24);
  pdf.setFontSize(9);
  pdf.setTextColor(120, 120, 120);
  pdf.text(new Date().toLocaleString('fr-FR'), w - 16, 24, { align: 'right' });
  pdf.addImage(url, 'PNG', 0, header, w, h);
  pdf.save(`${safeName(name)}.pdf`);
}

export function exportJson(map) {
  const blob = new Blob([JSON.stringify({ format: 'cyberdeck-pivot', version: 1, ...map }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download(url, `${safeName(map.name)}.pivot.json`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(r.result)); } catch (e) { reject(new Error('JSON invalide')); } };
    r.onerror = () => reject(new Error('lecture impossible'));
    r.readAsText(file);
  });
}
