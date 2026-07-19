// lib/product-factory.js — real digital product file generation: styled .xlsx spreadsheets
// (exceljs), Notion-importable CSV exports, and toolkit ZIP bundles. Every column, dropdown,
// conditional format, and formula here is written to a real file and round-trip-verified in
// tools/test-product-factory.js — never a text description of what a workbook "would contain"
// (the product-factory agent persona's own explicit rule).
//
// exceljs (not openpyxl — the persona file's tool list predates this being a Node codebase) was
// added as a new dependency for this feature; adm-zip was already in use for Web Studio export.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const MIN_VALIDATION_ROWS = 200; // dropdowns extend below the seed rows so the buyer can keep adding entries

function applySheet(workbook, sheetSpec) {
  const columns = Array.isArray(sheetSpec.columns) ? sheetSpec.columns : [];
  if (!columns.length) throw new Error(`sheet "${sheetSpec.name || '?'}" has no columns`);
  const ws = workbook.addWorksheet(String(sheetSpec.name || 'Sheet1').slice(0, 31));
  ws.columns = columns.map((c) => ({
    header: String(c.header || ''),
    key: String(c.header || '').toLowerCase().replace(/\s+/g, '_') || `col`,
    width: Number(c.width) > 0 ? Number(c.width) : 18,
  }));

  // Real formatted headers — not a description of them.
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  headerRow.height = 22;

  const rows = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : [];
  for (const row of rows) {
    const excelRow = ws.addRow(row);
    // Agents sometimes write a formula-looking string ("=SUM(...)") directly into a row cell
    // instead of using the dedicated `formulas` field below. addRow() stores that as inert text —
    // verified empirically it does NOT round-trip as a real formula — so promote it here via the
    // one assignment path that does (direct cell.value = {formula}), or it silently ships a
    // spreadsheet where the "formula" is just unclickable text. Never trust the shape an agent
    // says it followed; verify what actually landed in the cell.
    row.forEach((v, colIdx) => {
      if (typeof v === 'string' && /^=./.test(v)) excelRow.getCell(colIdx + 1).value = { formula: v.slice(1) };
    });
  }
  const lastDataRow = Math.max(rows.length + 1, MIN_VALIDATION_ROWS);

  // Real data validation (dropdown lists) — one per column that specifies `validation`.
  columns.forEach((c, i) => {
    if (!Array.isArray(c.validation) || !c.validation.length) return;
    const colLetter = ws.getColumn(i + 1).letter;
    const list = c.validation.map((v) => String(v).replace(/"/g, "'")).join(',');
    for (let r = 2; r <= lastDataRow; r++) {
      ws.getCell(`${colLetter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list}"`] };
    }
  });

  // Real conditional formatting keyed by column header + a value→color rule set.
  if (Array.isArray(sheetSpec.conditionalFormats)) {
    for (const cf of sheetSpec.conditionalFormats) {
      const colIdx = columns.findIndex((c) => c.header === cf.column);
      if (colIdx === -1 || !Array.isArray(cf.rules) || !cf.rules.length) continue;
      const colLetter = ws.getColumn(colIdx + 1).letter;
      ws.addConditionalFormatting({
        ref: `${colLetter}2:${colLetter}${lastDataRow}`,
        rules: cf.rules.map((r, i) => ({
          type: 'containsText', operator: 'containsText', text: String(r.equals || ''), priority: i + 1,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: /^[0-9A-Fa-f]{6,8}$/.test(r.color || '') ? `FF${String(r.color).replace(/^FF/i, '')}`.slice(0, 8) : 'FFDDDDDD' } } },
        })),
      });
    }
  }

  // Real formulas — must be set via direct cell assignment (an inline {formula} object inside
  // addRow()'s array does NOT round-trip as a formula; verified empirically against exceljs 4.4.0).
  if (Array.isArray(sheetSpec.formulas)) {
    for (const f of sheetSpec.formulas) {
      if (!f || !f.cell || !f.formula) continue;
      ws.getCell(f.cell).value = { formula: String(f.formula) };
    }
  }

  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

async function generateSpreadsheet({ sheets, destPath }) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('at least one sheet is required');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI OS Product Factory';
  workbook.created = new Date();
  for (const s of sheets) applySheet(workbook, s);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await workbook.xlsx.writeFile(destPath);
  return { bytes: fs.statSync(destPath).size };
}

// RFC 4180 CSV field escaping.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sheetToCsv(sheetSpec) {
  const columns = Array.isArray(sheetSpec.columns) ? sheetSpec.columns : [];
  const rows = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : [];
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

// Notion imports a database directly from one CSV. Multiple sheets become a ZIP of CSVs — Notion
// has no single-file multi-table import format, so this is the honest real output rather than a
// fabricated "live Notion workspace" (this platform has no Notion API integration/OAuth to build
// one for real).
function generateNotionExport({ sheets, destPath }) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('at least one sheet is required');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (sheets.length === 1) {
    fs.writeFileSync(destPath, sheetToCsv(sheets[0]), 'utf-8');
    return { bytes: fs.statSync(destPath).size };
  }
  const zip = new AdmZip();
  for (const s of sheets) {
    const name = `${String(s.name || 'sheet').replace(/[^A-Za-z0-9._-]+/g, '-')}.csv`;
    zip.addFile(name, Buffer.from(sheetToCsv(s), 'utf-8'));
  }
  zip.writeZip(destPath);
  return { bytes: fs.statSync(destPath).size };
}

// Toolkit bundle: the real spreadsheet + a real Markdown guide + the listing copy, zipped. The
// intermediate .xlsx exists only inside the archive, never as a separate loose file alongside it.
async function generateToolkitZip({ sheets, guide, listingTitle, listingDescription, tags, destPath }) {
  const tmpXlsx = `${destPath}.tmp.xlsx`;
  await generateSpreadsheet({ sheets, destPath: tmpXlsx });

  const zip = new AdmZip();
  zip.addLocalFile(tmpXlsx, '', 'Product.xlsx');
  if (guide) zip.addFile('Guide.md', Buffer.from(String(guide), 'utf-8'));
  const listing = [`# ${listingTitle || ''}`, '', listingDescription || '', tags && tags.length ? `\nTags: ${tags.join(', ')}` : ''].join('\n');
  zip.addFile('Listing.md', Buffer.from(listing, 'utf-8'));

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  zip.writeZip(destPath);
  fs.unlinkSync(tmpXlsx);
  return { bytes: fs.statSync(destPath).size };
}

// Allowlist for the serve route — only filenames this module itself generates.
const PRODUCT_FILE_RE = /^product-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(xlsx|csv|zip)$/;

module.exports = { generateSpreadsheet, generateNotionExport, generateToolkitZip, PRODUCT_FILE_RE };
