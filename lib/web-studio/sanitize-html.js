// lib/web-studio/sanitize-html.js
// ============================================================
//  Allowlist HTML sanitiser for CONTENT-AUTHORED rich text (the no-code content backend).
//
//  WHY THIS EXISTS. Every existing section renderer escapes its text (`esc()` in pipeline.js), so
//  a generated site could never emit author-supplied markup. That is safe but useless for real
//  article content — an imported blog's body is HTML (headings, links, lists, footnote anchors),
//  and escaping it renders the tags as visible literal text. The `article` section renders body
//  HTML UNESCAPED, so this module is the only thing standing between an author (or an imported
//  document) and stored XSS on a published customer domain.
//
//  THREAT MODEL. Input is untrusted: it arrives from the content API (a client-tier user), from
//  imported archives, and from scraped/recovered pages. Output is written into a static file that
//  is served from the customer's own origin, where a script would run with that origin's
//  privileges. So this is a DENY-BY-DEFAULT allowlist, not a blocklist of known-bad strings:
//    * only listed elements survive; everything else is dropped (its text content is kept)
//    * `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg`, `math` are dropped ENTIRELY,
//      content included — keeping their text would leak code into the page as prose
//    * only listed attributes survive, per element; `on*` handlers can never match the allowlist
//    * URL attributes must parse to an allowed scheme; `javascript:`, `data:` (except images) and
//      `vbscript:` are rejected, including obfuscated forms (entities, embedded control chars)
//    * comments are dropped (conditional comments execute in some engines)
//
//  It is deliberately a small, readable, dependency-free parser: adding a dependency to the public
//  core for this was rejected, and a regex-only "sanitiser" is the classic way to ship an XSS.
// ============================================================
'use strict';

// Elements whose TEXT is kept but whose tag is dropped when not allowed (default behaviour), versus
// elements that are removed wholesale with everything inside them.
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'noscript',
  'template', 'base', 'link', 'meta', 'title', 'applet', 'frame', 'frameset', 'button',
]);

// Allowed elements → allowed attributes for that element.
const ALLOWED = {
  p: [], br: [], hr: [],
  h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
  strong: [], b: [], em: [], i: [], u: [], s: [], sub: [], sup: [], mark: [], small: [],
  blockquote: ['cite'], q: ['cite'],
  ul: [], ol: ['start', 'type'], li: ['value'], dl: [], dt: [], dd: [],
  a: ['href', 'title', 'id', 'rel', 'target', 'name'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
  figure: [], figcaption: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [],
  th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
  caption: [], col: ['span'], colgroup: ['span'],
  code: [], pre: [], kbd: [], samp: [], var: [], abbr: ['title'], cite: [], time: ['datetime'],
  span: ['id'], div: ['id'], section: ['id'], article: ['id'], aside: ['id'],
  header: ['id'], footer: ['id'], nav: ['id'], main: ['id'],
};

// `id` is allowed on EVERY permitted element rather than a chosen few. Recovered archival content
// hangs footnote anchors off whatever tag the original author used — sup, li, td, span — and
// listing ids per element silently dropped 63 of 331 anchors on the real Oregon corpus, breaking
// the footnote links that point at them. An id is inert: it carries no script and no navigation.
for (const tag of Object.keys(ALLOWED)) if (!ALLOWED[tag].includes('id')) ALLOWED[tag].push('id');

const VOID = new Set(['br', 'hr', 'img', 'col']);
const URL_ATTRS = new Set(['href', 'src', 'cite']);
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// Characters that must be removed before a scheme check: C0/C1 controls, space, DEL, NBSP and the
// Unicode line/paragraph separators. "java\tscript:" and "java\0script:" are live URLs in some
// parsers, so leaving any of these in would let an attacker split the scheme.
//
// Built from CODE POINTS rather than a regex character class on purpose: a literal class of
// control characters is invisible in a diff and has already been corrupted once in this file by a
// tool that wrote the raw bytes instead of the escape sequences, producing an unparseable regex.
function stripInvisible(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const invisible = c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029;
    if (!invisible) out += ch;
  }
  return out;
}

// Decode entities far enough to catch scheme obfuscation (&#106;avascript:). Deliberately only used
// for the SAFETY CHECK — the original attribute text is what gets written, re-escaped.
function decodeForCheck(s) {
  return stripInvisible(String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
    .replace(/&amp;/gi, '&'));
}

function safeUrl(raw, { allowDataImage = false } = {}) {
  const probe = decodeForCheck(raw).toLowerCase();
  if (!probe) return null;
  if (probe.startsWith('#') || probe.startsWith('/') || probe.startsWith('./') || probe.startsWith('../')) return raw;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i.test(probe)) return raw;
  const colon = probe.indexOf(':');
  if (colon === -1) return raw;                       // relative path with no scheme
  // A colon that appears after a path separator is not a scheme ("foo/bar:baz").
  const slash = probe.indexOf('/');
  if (slash !== -1 && slash < colon) return raw;
  return SAFE_SCHEMES.has(probe.slice(0, colon + 1)) ? raw : null;
}

// Escape text WITHOUT re-escaping entities that are already there. A naive `&` -> `&amp;` turns an
// existing `&amp;` into `&amp;amp;`, which (a) is visible corruption in the rendered page and
// (b) makes the function non-idempotent — re-saving an article would add a layer every time.
// Measured on 19 real recovered articles: the naive form corrupted 8 of them.
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;
const escText = (s) => String(s)
  .replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,30};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Parse one tag's attributes. Handles double/single/unquoted values.
function parseAttrs(src) {
  const out = [];
  const re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    if (!m[0].trim()) break;
    out.push({ name: m[1].toLowerCase(), value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null });
  }
  return out;
}

/**
 * Sanitise a fragment of author-supplied HTML.
 * @param {string} html
 * @param {{allowDataImage?:boolean, maxLength?:number}} [opts]
 * @returns {string} safe HTML
 */
function sanitizeHtml(html, opts = {}) {
  if (html == null) return '';
  let src = String(html);
  if (opts.maxLength && src.length > opts.maxLength) src = src.slice(0, opts.maxLength);

  // Comments go first: `<!--[if IE]><script>` is a real execution path, and a stray `<!--` would
  // otherwise let the tag scanner walk into commented-out markup.
  src = src.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  src = src.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, '');
  src = src.replace(/<![^>]*>/g, '');                  // doctype and other declarations

  // Remove drop-with-content elements, including unclosed ones (`<script>` to EOF).
  for (const tag of DROP_WITH_CONTENT) {
    src = src.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '\\s*>', 'gi'), '');
    src = src.replace(new RegExp('<' + tag + '\\b[\\s\\S]*$', 'i'), '');
  }

  const out = [];
  const open = [];                                      // stack of emitted open tags
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;

  while ((m = tagRe.exec(src))) {
    if (m.index > last) out.push(escText(src.slice(last, m.index)));
    last = tagRe.lastIndex;

    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const allowedAttrs = ALLOWED[tag];
    if (!allowedAttrs) continue;                        // not allowed: drop the TAG, keep its text

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;                          // stray close tag
      // Close anything opened inside it, so output stays well formed.
      while (open.length > at) out.push('</' + open.pop() + '>');
      continue;
    }

    // Collect into a MAP keyed by attribute name, deduplicating by construction, then post-process.
    // Doing the target/rel pairing inline made the pass order matter: on a second sanitise of
    // already-sanitised HTML the existing `rel` was parsed AFTER `target`, so a second
    // rel="noopener noreferrer" was appended and the function was not idempotent.
    const attrMap = new Map();
    for (const a of parseAttrs(m[3] || '')) {
      if (!allowedAttrs.includes(a.name)) continue;     // covers every on* handler by construction
      if (attrMap.has(a.name)) continue;                // first occurrence wins
      if (a.value === null) { attrMap.set(a.name, null); continue; }
      let v = a.value;
      if (URL_ATTRS.has(a.name)) {
        const ok = safeUrl(v, { allowDataImage: !!opts.allowDataImage && tag === 'img' && a.name === 'src' });
        if (ok === null) continue;                      // unsafe scheme: drop the attribute
        v = ok;
      }
      if (a.name === 'rel') v = String(v).replace(/[^a-zA-Z0-9 _-]/g, '').trim();
      attrMap.set(a.name, v);
    }
    // A target="_blank" without noopener hands the opener window to the destination.
    if (attrMap.get('target') === '_blank' && allowedAttrs.includes('rel')) {
      const rel = String(attrMap.get('rel') || '');
      const parts = rel.split(/\s+/).filter(Boolean);
      for (const need of ['noopener', 'noreferrer']) if (!parts.includes(need)) parts.push(need);
      attrMap.set('rel', parts.join(' '));
    }
    const attrs = [...attrMap].map(([k, v]) => (v === null ? k : k + '="' + escAttr(v) + '"'));

    const isVoid = VOID.has(tag) || /\/\s*$/.test(m[3] || '');
    if (isVoid) { out.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + ' />'); continue; }
    out.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
    open.push(tag);
  }
  if (last < src.length) out.push(escText(src.slice(last)));
  while (open.length) out.push('</' + open.pop() + '>');   // close anything left dangling

  return out.join('');
}

/** Plain text of a fragment — for excerpts, word counts and AEO signals. */
function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

// The allowlist tables stay private: exporting them invites a caller to mutate the policy at
// runtime, which is the opposite of what a deny-by-default sanitizer is for.
module.exports = { sanitizeHtml, htmlToText, safeUrl };
