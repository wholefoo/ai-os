// lib/docx-markdown.js — shared markdown-ish → docx Paragraph[] renderer.
//
// Handles #/##/### headings, - / * bullets, and **bold** inline spans; everything else becomes a
// plain body paragraph. Deliberately simple (no tables, no nested lists) so odd/unexpected model
// output degrades to plain readable paragraphs instead of crashing docx generation. Shared by
// lib/intel-brief.js (daily statements) and lib/pipeline-reports.js (pipeline run exports) so both
// render identically and can't silently drift apart.

const { Paragraph, TextRun, HeadingLevel, LevelFormat } = require('docx');

const BULLET_REF = 'md-bullets';

// Numbering config for the bullet list reference above — include this in every Document that uses
// markdownToParagraphs, or bulleted lines will render as plain paragraphs missing their bullet.
function bulletNumberingConfig() {
  return {
    reference: BULLET_REF,
    levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: 'left', style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
  };
}

function mdRuns(line) {
  const runs = [];
  const parts = String(line).split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    runs.push(new TextRun({ text: m ? m[1] : p, bold: !!m }));
  }
  return runs.length ? runs : [new TextRun('')];
}

function markdownToParagraphs(text) {
  const children = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1].length - 1];
      children.push(new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: mdRuns(h[2]) }));
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) {
      children.push(new Paragraph({ numbering: { reference: BULLET_REF, level: 0 }, children: mdRuns(b[1]) }));
      continue;
    }
    children.push(new Paragraph({ spacing: { after: 120 }, children: mdRuns(line) }));
  }
  return children;
}

module.exports = { markdownToParagraphs, bulletNumberingConfig };
