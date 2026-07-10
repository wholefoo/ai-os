// lib/okf.js
// ============================================================
//  Open Knowledge Format (OKF) v0.1 — Google Cloud's vendor-neutral spec for agent-ready
//  knowledge bundles: a directory of markdown files with YAML frontmatter, where the file path
//  is the concept's identity and normal markdown links form the knowledge graph.
//  Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf (Apache 2.0).
//
//  The interoperability surface is deliberately tiny: exactly ONE required frontmatter field
//  (`type`), five standardized optional fields (title, description, resource, tags, timestamp),
//  reserved filenames index.md (progressive disclosure) and log.md (chronology). No runtime,
//  no SDK, portable as a tarball — which is why this module is dependency-free and hand-rolls
//  the flat YAML subset the spec actually uses rather than pulling a YAML library.
//
//  Consumers in this repo: Web Studio emits a bundle into every generated site (public/knowledge/
//  — the agent-ready-site AEO play), and the admin OKF export packages the platform's own
//  knowledge (agents registry, docs map) as a downloadable bundle.
// ============================================================

const fs = require('fs');
const path = require('path');

const STD_FIELDS = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'];

// Quote a YAML scalar defensively: plain if clearly safe, double-quoted otherwise.
function yamlScalar(v) {
  const s = String(v == null ? '' : v);
  if (/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
}

// Serialize one concept to an OKF markdown document. `fm` must include `type`; the five
// standardized fields are emitted in spec order, any extra producer fields after them.
function serializeConcept(fm, body) {
  if (!fm || !fm.type) throw new Error('OKF concept requires a `type` frontmatter field');
  const lines = ['---'];
  for (const k of STD_FIELDS) {
    if (fm[k] == null || fm[k] === '') continue;
    if (k === 'tags') {
      const tags = (Array.isArray(fm.tags) ? fm.tags : [fm.tags]).filter(Boolean);
      if (tags.length) lines.push(`tags: [${tags.map(yamlScalar).join(', ')}]`);
    } else {
      lines.push(`${k}: ${yamlScalar(fm[k])}`);
    }
  }
  for (const k of Object.keys(fm)) {
    if (STD_FIELDS.includes(k) || fm[k] == null || fm[k] === '') continue;
    lines.push(`${k}: ${yamlScalar(fm[k])}`);
  }
  lines.push('---', '');
  return lines.join('\n') + String(body || '').trim() + '\n';
}

// Parse an OKF document → { frontmatter, body }. Tolerant flat-YAML subset: `key: value` lines,
// inline [a, b] arrays, quoted scalars. Returns null frontmatter if the document has none.
function parseConcept(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: String(text || '') };
  const fm = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, valRaw] = kv;
    let val = valRaw.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
    } else {
      fm[key] = unquote(val);
    }
  }
  return { frontmatter: fm, body: m[2] };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

// Write a bundle to disk. files = [{ relPath, fm, body }]. relPaths are sanitized to stay
// inside destDir. Returns the list of relative paths written.
function writeBundle(destDir, files) {
  const written = [];
  for (const f of files || []) {
    const rel = String(f.relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) continue; // path-escape guard
    const abs = path.join(destDir, rel);
    if (!path.resolve(abs).startsWith(path.resolve(destDir))) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, serializeConcept(f.fm, f.body));
    written.push(rel);
  }
  return written;
}

// Validate a bundle directory against the v0.1 conformance surface: every .md parses, every
// concept has `type`, and relative markdown links resolve to files inside the bundle.
// Returns { ok, concepts, issues } — issues are strings, empty when conformant.
function validateBundle(dir) {
  const issues = [];
  const concepts = [];
  const walk = (cur) => {
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const abs = path.join(cur, it.name);
      if (it.isDirectory()) { if (!it.name.startsWith('.')) walk(abs); continue; }
      if (!it.name.endsWith('.md')) continue;
      const rel = path.relative(dir, abs).replace(/\\/g, '/');
      const { frontmatter, body } = parseConcept(fs.readFileSync(abs, 'utf8'));
      if (!frontmatter) { issues.push(`${rel}: no YAML frontmatter`); continue; }
      if (!frontmatter.type) issues.push(`${rel}: missing required \`type\` field`);
      concepts.push({ relPath: rel, frontmatter });
      // cross-link check: root-relative and relative .md links must resolve within the bundle
      for (const lm of String(body).matchAll(/\]\((\/?[^)\s#]+\.md)(#[^)]*)?\)/g)) {
        const target = lm[1].startsWith('/') ? path.join(dir, lm[1]) : path.join(path.dirname(abs), lm[1]);
        if (!path.resolve(target).startsWith(path.resolve(dir))) { issues.push(`${rel}: link escapes bundle → ${lm[1]}`); continue; }
        if (!fs.existsSync(target)) issues.push(`${rel}: broken link → ${lm[1]}`);
      }
    }
  };
  walk(dir);
  if (!concepts.length) issues.push('bundle contains no OKF concepts (*.md with frontmatter)');
  return { ok: issues.length === 0, concepts, issues };
}

module.exports = { serializeConcept, parseConcept, writeBundle, validateBundle };
