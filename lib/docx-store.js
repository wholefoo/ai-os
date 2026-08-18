// lib/docx-store.js — shared on-disk store for generated .docx artifacts and their JSON sidecars.
//
// lib/intel-brief.js (daily statements) and lib/pipeline-reports.js (pipeline run exports) keep the
// same thing on disk: a directory of .docx files, each paired with a same-basename .json sidecar
// holding the metadata the dashboard lists. The three operations over that store — write the pair,
// delete the pair, list the pairs newest-first — were spelled out twice and had to be changed
// twice. They live here once so the sidecar naming rule, the allowlist-before-touching-the-disk
// order, and the tolerance for a missing/corrupt sidecar can't silently drift apart.
//
// What deliberately does NOT live here: the filename POLICY (intel-brief suffixes so a same-day
// rerun never overwrites; pipeline-reports overwrites by run id) and the metadata fields each
// caller records. Those differ on purpose — only the store mechanics are shared.

const fs = require('fs');
const path = require('path');
const { Packer } = require('docx');

// Every artifact's metadata lives beside it under the same basename.
function sidecarFor(docxPath) {
  return docxPath.replace(/\.docx$/, '.json');
}

// Write the docx and its sidecar as a pair. The caller owns `file` (its naming policy) and `meta`
// (its own fields); `meta` is returned unchanged so callers can `return writeDocxPair(...)`.
async function writeDocxPair({ dir, file, doc, meta }) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  fs.writeFileSync(full, await Packer.toBuffer(doc));
  fs.writeFileSync(sidecarFor(full), JSON.stringify(meta, null, 2));
  return meta;
}

// Delete one artifact pair. `fileRe` is the caller's download/delete allowlist — a name that fails
// it never touches the filesystem at all. An already-missing sidecar is not an error.
function deleteDocxPair(dir, file, fileRe) {
  if (!fileRe.test(file)) return false;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  try { fs.unlinkSync(sidecarFor(full)); } catch {}
  return true;
}

// List every artifact in `dir` matching `fileRe`, newest first. `toEntry(file, meta, stat)` adds the
// caller's own fields on top of the common ones. A missing or unparseable sidecar degrades to {}
// rather than throwing, and a nonexistent directory lists as [].
function listDocxPairs(dir, fileRe, toEntry) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => fileRe.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(sidecarFor(full), 'utf8')); } catch {}
        const stat = fs.statSync(full);
        return {
          file: f, size: stat.size,
          createdAt: meta.createdAt || stat.mtime.toISOString(),
          summary: meta.summary || '',
          ...toEntry(f, meta, stat),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { return []; }
}

module.exports = { writeDocxPair, deleteDocxPair, listDocxPairs };
