// lib/web-studio/design-extract.js
// ============================================================
//  "Clone design from a URL" — point at a public site and pull a DESIGN PROFILE:
//  color + font tokens (mapped onto the scaffold's brand/accent/ink/paper + fonts) and a
//  coarse section outline (mapped onto the pipeline's allowed section types). The pipeline
//  then generates OUR OWN clean Astro markup in that style — tokens + layout patterns, not a
//  verbatim mirror.
//
//  The target URL is UNTRUSTED. Network safety (SSRF IP-pinning, redirect re-validation, byte +
//  time caps) lives in lib/net/safe-fetch. Here we add the content-safety: font-family names are
//  allowlisted to a strict CSS shape before they can reach the LLM plan prompt or the served CSS,
//  and a shared deadline + aggregate-CSS cap bound the parse work.
// ============================================================

const { safeFetch } = require('../net/safe-fetch');

const UA = 'Mozilla/5.0 (compatible; AI-OS-WebStudio/1.0; design-clone)';
const ALLOWED_SECTIONS = ['hero', 'features', 'prose', 'cta', 'contact'];
const FAMILY_RE = /^[A-Za-z0-9 _-]{1,40}$/; // strict CSS family-name shape (no punctuation → no prompt/CSS escape)

// ---------- color helpers ----------
function normHex(h) {
  let s = h.replace('#', '').toLowerCase();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length === 8) s = s.slice(0, 6);
  return s.length === 6 ? '#' + s : null;
}
function rgbToHex(inner) {
  const n = inner.split(',').map((x) => parseFloat(x.trim()));
  if (n.length < 3 || n.slice(0, 3).some((x) => isNaN(x))) return null;
  const to = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + to(n[0]) + to(n[1]) + to(n[2]);
}
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function saturation(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

// Tally colors out of text into `freq`, capped so a hostile token-spam body can't explode memory.
function collectColorsInto(freq, text, cap = 40000) {
  let m, n = 0;
  const reHex = /#[0-9a-fA-F]{3,8}\b/g;
  while (n < cap && (m = reHex.exec(text))) { const h = normHex(m[0]); if (h) freq.set(h, (freq.get(h) || 0) + 1); n++; }
  const reRgb = /rgba?\(([^)]{1,64})\)/gi; n = 0;
  while (n < cap && (m = reRgb.exec(text))) { const h = rgbToHex(m[1]); if (h) freq.set(h, (freq.get(h) || 0) + 1); n++; }
  return freq;
}

// ---------- font helpers ----------
function familyList(decl) { return decl.split(',')[0].replace(/['"]/g, '').trim(); }
function cleanFamily(name) { return name && FAMILY_RE.test(name) ? name : null; } // allowlist → no injection
function collectFonts(css, html) {
  const all = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}\n]{1,120})/gi)) all.push(m[1].trim());
  const gf = [];
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]{1,300})/gi)) {
    for (const f of m[1].matchAll(/family=([^&:]{1,60})/gi)) gf.push(decodeURIComponent(f[1].replace(/\+/g, ' ')));
  }
  const bodyRule = css.match(/(?:^|[\s,{])(?:body|html)\b[^{]*\{[^}]*font-family\s*:\s*([^;}\n]{1,120})/i);
  const headRule = css.match(/(?:^|[\s,{])h1\b[^{]*\{[^}]*font-family\s*:\s*([^;}\n]{1,120})/i);
  const display = cleanFamily(headRule ? familyList(headRule[1]) : null) || cleanFamily(gf[0]) || cleanFamily(all[0] ? familyList(all[0]) : null);
  const body = cleanFamily(bodyRule ? familyList(bodyRule[1]) : null) || cleanFamily(gf[1]) || cleanFamily(gf[0]) || cleanFamily(all[0] ? familyList(all[0]) : null);
  return { display, body, googleFonts: [...new Set(gf.map(cleanFamily).filter(Boolean))].slice(0, 6) };
}

// ---------- layout outline ----------
function detectSections(html) {
  const lc = html.slice(0, 1_500_000).toLowerCase(); // structure lives near the top; bound the scan
  const count = (re) => (lc.match(re) || []).length;
  const out = ['hero'];
  const h3 = count(/<h3[\s>]/g), li = count(/<li[\s>]/g), cards = count(/class="[^"]*\b(card|feature|grid)\b/gi);
  if (h3 >= 3 || cards >= 2 || li >= 6) out.push('features');
  if (count(/<blockquote[\s>]/g) >= 1 || /testimonial|review|what (our|their) (clients|customers)/i.test(lc)) out.push('prose');
  if (/<article[\s>]/i.test(lc) || count(/<p[\s>]/g) >= 8) { if (!out.includes('prose')) out.push('prose'); }
  if (/get started|sign up|book a|start (free|now)|request a demo|contact us/i.test(lc)) out.push('cta');
  if (/<footer[\s>]/i.test(lc) || /mailto:|contact/i.test(lc)) out.push('contact');
  return out.filter((s, i) => ALLOWED_SECTIONS.includes(s) && out.indexOf(s) === i);
}

// ---------- main ----------
/**
 * Extract a design profile from a public URL. Never trusts the content; throws only on a hard
 * fetch/SSRF failure (callers surface the message).
 * @returns {Promise<{sourceUrl, title, tokens, sections, swatches, fonts, notes}>}
 */
async function extractProfile(rawUrl) {
  const deadline = Date.now() + 20000;            // ONE budget shared across the page + CSS fetches
  const html = await safeFetch(rawUrl, { deadline, userAgent: UA });
  const notes = [];
  const base = new URL(rawUrl);

  // CSS: inline <style> + a few linked stylesheets fetched CONCURRENTLY (same SSRF guard + deadline)
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const links = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => (m[0].match(/href=["']([^"']+)["']/i) || [])[1]).filter(Boolean).slice(0, 6);
  const fetched = await Promise.allSettled(links.map((href) => {
    let abs; try { abs = new URL(href, base).href; } catch { return Promise.reject(new Error('bad href')); }
    return safeFetch(abs, { maxBytes: 1_500_000, deadline, userAgent: UA });
  }));
  for (const r of fetched) {
    if (r.status !== 'fulfilled') continue;
    css += '\n' + r.value;
    if (css.length > 4_000_000) { css = css.slice(0, 4_000_000); break; } // aggregate CSS cap
  }
  if (!css.trim()) notes.push('no external CSS found — palette inferred from inline styles only');

  // tokens — scan css and html SEPARATELY (no giant third concat), capped
  const freq = new Map();
  collectColorsInto(freq, css);
  collectColorsInto(freq, html.slice(0, 3_000_000));
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([hex, n]) => ({ hex, n }));
  const light = colors.filter((c) => luminance(c.hex) > 0.82);
  const dark = colors.filter((c) => luminance(c.hex) < 0.18);
  const vivid = colors.filter((c) => saturation(c.hex) > 0.32 && luminance(c.hex) > 0.12 && luminance(c.hex) < 0.9);
  const paper = (light[0] || {}).hex || '#ffffff';
  const ink = (dark[0] || {}).hex || '#0f172a';
  const brand = (vivid[0] || {}).hex || '#4f46e5';
  const accent = (vivid.find((c) => c.hex !== brand) || {}).hex || '#f59e0b';

  const f = collectFonts(css, html);
  const tokens = {
    brand, accent, ink, paper,
    fontDisplay: f.display ? `'${f.display}', Georgia, serif` : "Georgia, 'Times New Roman', serif",
    fontBody: f.body ? `'${f.body}', system-ui, sans-serif` : 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  };

  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const swatches = [...new Set([brand, accent, ink, paper, ...vivid.slice(0, 4).map((c) => c.hex)])]
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8);

  return { sourceUrl: base.href, title, tokens, sections: detectSections(html), swatches, fonts: { display: f.display, body: f.body, googleFonts: f.googleFonts }, notes };
}

module.exports = { extractProfile };
