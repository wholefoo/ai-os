// Product Factory real file generation (lib/product-factory.js): styled .xlsx via exceljs
// (headers, dropdown data validation, conditional formatting, formulas — each round-trip
// verified by reading the file back, not just checking it didn't throw), Notion-importable CSV
// export, and toolkit ZIP bundling. No mocking — these are real files on real disk, since the
// whole point of this feature is that a "product" must be an actual generated file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, cleanupAndFinish } = require('./test-util');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const productFactory = require('../lib/product-factory');
const { generateSpreadsheet, generateNotionExport, generateToolkitZip, PRODUCT_FILE_RE } = productFactory;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-factory-'));

  const sheets = [{
    name: 'Books',
    columns: [
      { header: 'Title', width: 24 },
      { header: 'Status', width: 16, validation: ['Not Started', 'Reading', 'Done'] },
      { header: 'Rating', width: 10 },
    ],
    rows: [['Dune', 'Reading', 4], ['Hyperion', 'Not Started', ''], ['Average', '', '=AVERAGE(C2:C3)']],
    conditionalFormats: [{ column: 'Status', rules: [{ equals: 'Done', color: 'CCFFCC' }] }],
    formulas: [{ cell: 'C6', formula: 'AVERAGE(C2:C3)' }],
  }];

  // --- PRODUCT_FILE_RE allowlist
  const validXlsx = 'product-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.xlsx';
  const validCsv = 'product-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.csv';
  const validZip = 'product-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.zip';
  assert(PRODUCT_FILE_RE.test(validXlsx) && PRODUCT_FILE_RE.test(validCsv) && PRODUCT_FILE_RE.test(validZip), 'allowlist accepts real generated filenames for all three extensions');
  for (const bad of ['../../etc/passwd', 'product-not-a-uuid.xlsx', 'evil.xlsx', validXlsx + '.exe', validXlsx.replace('.xlsx', '.exe')]) {
    assert(!PRODUCT_FILE_RE.test(bad), `allowlist rejects "${bad}"`);
  }

  // --- generateSpreadsheet(): throws with no sheets, never silently writes an empty file
  try {
    await generateSpreadsheet({ sheets: [], destPath: path.join(dir, 'empty.xlsx') });
    assert(false, 'generateSpreadsheet should throw with zero sheets');
  } catch (e) {
    assert(/at least one sheet/.test(e.message), `clear error for zero sheets (got "${e.message}")`);
  }

  // --- generateSpreadsheet(): throws when a sheet has no columns
  try {
    await generateSpreadsheet({ sheets: [{ name: 'X', rows: [] }], destPath: path.join(dir, 'nocols.xlsx') });
    assert(false, 'generateSpreadsheet should throw when a sheet has no columns');
  } catch (e) {
    assert(/no columns/.test(e.message), `clear error for a columnless sheet (got "${e.message}")`);
  }

  // --- generateSpreadsheet(): real file, real formatted headers, real dropdown, real conditional format, real formula
  const xlsxPath = path.join(dir, 'nested', 'tracker.xlsx');
  const xlsxResult = await generateSpreadsheet({ sheets, destPath: xlsxPath });
  assert(fs.existsSync(xlsxPath), 'generateSpreadsheet creates the parent directory and writes the file');
  assert(xlsxResult.bytes === fs.statSync(xlsxPath).size, `reported byte count matches the real file size (${xlsxResult.bytes})`);
  assert(fs.readFileSync(xlsxPath).slice(0, 2).toString('hex') === '504b', 'the .xlsx is a real ZIP-based OOXML file (PK magic bytes)');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet('Books');
  assert(!!ws, 'the real sheet name round-trips');
  assert(ws.getCell('A1').value === 'Title' && ws.getCell('B1').value === 'Status', 'real header text is present in row 1');
  assert(ws.getCell('A1').fill && ws.getCell('A1').fill.fgColor.argb === 'FF2563EB', 'header cells carry real fill styling, not just plain text');
  assert(ws.getCell('A1').font && ws.getCell('A1').font.bold === true, 'header cells carry real bold styling');
  assert(ws.getCell('A2').value === 'Dune' && ws.getCell('B2').value === 'Reading', 'real seed row data is present');
  const validation = ws.getCell('B2').dataValidation;
  assert(validation && validation.type === 'list' && validation.formulae[0].includes('Not Started'), `real dropdown data validation is attached to the Status column (got ${JSON.stringify(validation)})`);
  assert(ws.getCell('B150').dataValidation && ws.getCell('B150').dataValidation.type === 'list', 'dropdown validation extends well past the seed rows so a buyer can keep adding entries');
  const cf = ws.conditionalFormattings.find((c) => c.ref.startsWith('B'));
  assert(cf && cf.rules[0].formulae[0].includes('"Done"'), `real conditional formatting rule targets the Status column, matching on "Done" (got ${JSON.stringify(cf)})`);
  const formulaCell = ws.getCell('C6').value;
  assert(formulaCell && formulaCell.formula === 'AVERAGE(C2:C3)', `a formula declared via the dedicated \`formulas\` field round-trips as an actual formula, not a computed string (got ${JSON.stringify(formulaCell)})`);
  // Agents sometimes put a formula-looking string directly in a row cell instead of using the
  // `formulas` field — this must ALSO be promoted to a real formula, not shipped as inert text
  // (a live product-factory run surfaced exactly this: an agent wrote "=C2/D2" as plain row data).
  const inlineFormulaCell = ws.getCell('C4').value;
  assert(inlineFormulaCell && inlineFormulaCell.formula === 'AVERAGE(C2:C3)', `a formula-looking string written directly into row data is auto-promoted to a real formula (got ${JSON.stringify(inlineFormulaCell)})`);
  assert(ws.pageSetup.fitToPage === true && ws.pageSetup.orientation === 'landscape', 'print-ready page setup round-trips');
  assert(ws.views[0].state === 'frozen' && ws.views[0].ySplit === 1, 'header row freeze pane round-trips');

  // --- generateNotionExport(): a single sheet becomes a plain CSV, correctly RFC4180-escaped
  const csvPath = path.join(dir, 'single.csv');
  const csvSheets = [{ name: 'Books', columns: [{ header: 'Title' }, { header: 'Notes' }], rows: [['Dune', 'has a "great" intro, really'], ['A, B, C', 'multi\nline']] }];
  const csvResult = generateNotionExport({ sheets: csvSheets, destPath: csvPath });
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  assert(csvResult.bytes === fs.statSync(csvPath).size, 'reported byte count matches the real CSV file size');
  assert(csvContent.split('\r\n')[0] === 'Title,Notes', 'CSV header row is correct');
  assert(csvContent.includes('"has a ""great"" intro, really"'), 'a field containing a comma and quotes is RFC4180-quoted and quote-escaped');
  assert(csvContent.includes('"A, B, C"'), 'a field containing a comma is quoted');

  // --- generateNotionExport(): multiple sheets become a ZIP of individual CSVs (Notion has no single-file multi-table import)
  const multiSheets = [{ name: 'Books', columns: [{ header: 'Title' }], rows: [['Dune']] }, { name: 'Movies', columns: [{ header: 'Title' }], rows: [['Arrival']] }];
  const zipCsvPath = path.join(dir, 'multi.zip');
  generateNotionExport({ sheets: multiSheets, destPath: zipCsvPath });
  const zippedCsvs = new AdmZip(zipCsvPath);
  const entries = zippedCsvs.getEntries().map((e) => e.entryName).sort();
  assert(entries.length === 2 && entries.includes('Books.csv') && entries.includes('Movies.csv'), `multi-sheet Notion export produces one CSV per sheet inside a real ZIP (got ${JSON.stringify(entries)})`);

  // --- generateToolkitZip(): bundles a real spreadsheet + a real guide + real listing copy, and leaves no loose intermediate .xlsx behind
  const toolkitPath = path.join(dir, 'toolkit.zip');
  const toolkitResult = await generateToolkitZip({
    sheets, guide: '# How to use this\n\nFill in your books.', listingTitle: 'Book Tracker Pro',
    listingDescription: 'Track every book you read.', tags: ['books', 'tracker'], destPath: toolkitPath,
  });
  assert(fs.existsSync(toolkitPath) && toolkitResult.bytes === fs.statSync(toolkitPath).size, 'toolkit ZIP is written with a correct reported byte count');
  assert(!fs.existsSync(`${toolkitPath}.tmp.xlsx`), 'the intermediate .xlsx is cleaned up — it lives only inside the ZIP');
  const toolkitZip = new AdmZip(toolkitPath);
  const toolkitEntries = toolkitZip.getEntries().map((e) => e.entryName).sort();
  assert(JSON.stringify(toolkitEntries) === JSON.stringify(['Guide.md', 'Listing.md', 'Product.xlsx']), `toolkit ZIP contains exactly the real spreadsheet, guide, and listing copy (got ${JSON.stringify(toolkitEntries)})`);
  assert(toolkitZip.readAsText('Guide.md').includes('Fill in your books'), 'the real guide content is present in the ZIP, not a placeholder');
  assert(toolkitZip.readAsText('Listing.md').includes('Book Tracker Pro') && toolkitZip.readAsText('Listing.md').includes('books, tracker'), 'the real listing title and tags are present in the ZIP');
  const bundledXlsx = toolkitZip.getEntry('Product.xlsx').getData();
  assert(bundledXlsx.slice(0, 2).toString('hex') === '504b', 'the bundled Product.xlsx inside the ZIP is itself a real OOXML file, not a placeholder blob');

  cleanupAndFinish(dir);
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; cleanupAndFinish(); });
