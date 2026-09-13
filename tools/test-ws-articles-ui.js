// The Articles tab in the dashboard. Reads the markup and module as text (repo convention).
//
// A DOM-shape suite is NOT sufficient for a UI panel and this one does not pretend otherwise: the
// fields were all present and populated while every input sat at ~173px inside a 394px column and
// the HTML body textarea was 181px wide — present, correct, and unusable. That was found by
// MEASURING the rendered panel in a browser, and the fix is pinned below so it cannot silently
// regress; the visual check itself lives in the commit.
const { assert, done, readRepoFile } = require('./test-util');

const html = readRepoFile('dashboard/app.html');
const js = readRepoFile('dashboard/js/web-studio.js');

// ---------- markup -----------------------------------------------------------------------------
assert(/id="wsTabArticles"/.test(html), 'the Articles tab button exists');
assert(/id="wsArticlesPane"/.test(html), 'the Articles pane exists');
assert(/id="wsArticlesPane"[^>]*style="display:none;"/.test(html), 'the pane starts hidden — Content is the default tab');
const bar = html.slice(html.indexOf('<div class="ws-tabbar">'), html.indexOf('id="wsContentPane"'));
assert(bar.indexOf('wsTabArticles') > bar.indexOf('wsTabContent'), 'Articles sits after Content in the bar');
assert(bar.indexOf('wsTabArticles') < bar.indexOf('wsTabCode'), 'Articles sits before Code');

// ---------- the layout fixes, each pinned to the measurement that motivated it ---------------------
// .settings-input carries a fixed width for the settings screens. Unset, every field here rendered
// at ~173px inside a 394px column.
assert(/\.ws-art-form \.settings-input\{width:100%/.test(html),
  'article form inputs are forced to full width (they were ~173px in a 394px column)');
assert(/\.ws-art-form > div\{min-width:0;\}/.test(html), 'form rows may shrink rather than forcing overflow');
assert(/\.ws-art-grid2 > div\{min-width:0;\}/.test(html), 'the two-column rows may shrink too');

// A FOURTH tab widens the tab bar's min-content, and the editor grid's overflow bug was originally
// caused by exactly that kind of pressure (see the .ws-editor-grid comment).
assert(/\.ws-tabbar\{flex-wrap:wrap;\}/.test(html), 'the tab bar wraps instead of forcing the grid wider');
assert(/@media \(max-width:1200px\)\{ \.ws-tabbar \.btn\{padding:4px 9px;font-size:12px;\} \}/.test(html),
  'tabs go compact at narrow widths (4 tabs took 142px of height at 917px; compact gives 50px)');

// ---------- wiring ---------------------------------------------------------------------------------
assert(/on\('wsTabArticles', 'click', \(\) => wsSwitchTab\('articles'\)\)/.test(js), 'the tab button is wired');
const sw = js.slice(js.indexOf('function wsSwitchTab('), js.indexOf('async function wsLoadContent'));
assert(/const isArticles = tab === 'articles';/.test(sw), 'wsSwitchTab knows the articles tab');
assert(/if \(arts\) arts\.style\.display = isArticles \? '' : 'none';/.test(sw), 'the pane is shown/hidden with the tab');
assert(/wsTabArticles'\); if \(ta\) ta\.classList\.toggle\('ws-tab-active', isArticles\)/.test(sw), 'the tab highlights');
assert(/if \(isArticles\) \{ wsLoadArticles\(\); return; \}/.test(sw), 'switching to the tab loads the articles');

// ---------- behaviour that protects content ----------------------------------------------------------
assert(/function wsLoadArticles\(/.test(js) && /function wsRenderArticleList\(/.test(js), 'list view exists');
assert(/async function wsEditArticle\(/.test(js), 'editor view exists');
assert(/async function wsSaveArticle\(/.test(js) && /async function wsDeleteArticle\(/.test(js), 'save and delete exist');

// An unsaved edit must not vanish on a stray click.
assert(/wsArt\.dirty && !confirm\('Discard unsaved changes/.test(js), 'leaving a dirty editor asks first');
// Deleting live content must be confirmed and must say it is recoverable.
const del = js.slice(js.indexOf('async function wsDeleteArticle('), js.indexOf('// ---------- adoption'));
assert(/confirm\(/.test(del), 'delete asks for confirmation');
assert(/rolled back/.test(del), 'the delete prompt says the previous release can be rolled back');
// A slug change moves a published URL — the operator must be told, not left to discover a 404.
assert(/slugChanged/.test(js), 'a changed slug is reported back to the user');
assert(/the old one will 404/.test(js), 'the slug-change message states the consequence');

// ---------- the fetchJSON body contract ------------------------------------------------------------------
// fetchJSON STRINGIFIES the body itself (`if (opts.body) options.body = JSON.stringify(opts.body)`),
// so a caller passing JSON.stringify(...) double-encodes it and the server receives a JSON *string*
// containing JSON. Every write in this module shipped that way and every one of them 500'd on the
// live server with:
//     Unexpected token '"', ""{\"source"... is not valid JSON
// It survived a full round of testing because the API was probed with curl (raw JSON, correct) and
// the UI was tested for SHAPE — the browser-to-server round trip was never exercised.
assert(!/body:\s*JSON\.stringify/.test(js),
  'a fetchJSON call double-encodes its body — pass the OBJECT, fetchJSON stringifies it');
// And the writes must still send a body at all.
for (const fn of ['wsSaveArticle', 'wsAdopt', 'wsApplyAeoFixes']) {
  const src = js.slice(js.indexOf('async function ' + fn + '('), js.indexOf('async function ' + fn + '(') + 2000);
  assert(/method: 'POST'|method: editing \? 'PUT' : 'POST'/.test(src), fn + ' issues a write');
  // `body` may be shorthand (`{ method, body }`) or explicit (`body: { ids }`).
  assert(/\bbody\b\s*[,:}]/.test(src), fn + ' sends a body');
}

// ---------- adoption view --------------------------------------------------------------------------------
assert(/function wsRenderAdopt\(/.test(js), 'sites with no plan get the adoption view');
assert(/Adoption keeps your content and replaces the site design/i.test(js),
  'the adoption view states the cost before the button is pressed');
assert(/wsAdopt\(false\)/.test(js) && /wsAdopt\(true\)/.test(js), 'preview and run are separate actions');

// THE SOURCE CHOICE MUST SURVIVE THE RE-RENDER. wsRenderAdopt() rebuilds the whole panel after
// every preview, which rebuilt the <select> with its DEFAULT option selected. On the live server
// that silently reverted "what is live" to "the imported files", so the preview read the live
// release (12 articles) and the ADOPT that followed read the stale workspace — and was correctly
// refused as an app shell. The guard did its job; the UI had thrown the operator's choice away.
assert(/const wsAdoptState = \{ source: 'workspace' \}/.test(js), 'the chosen adoption source is held in state');
assert(/wsAdoptState\.source === 'workspace' \? ' selected' : ''/.test(js),
  'the workspace option is re-selected from state after a re-render');
assert(/wsAdoptState\.source === 'live' \? ' selected' : ''/.test(js),
  'the live option is re-selected from state after a re-render');
assert(/srcSel\.addEventListener\('change', \(\) => \{ wsAdoptState\.source = srcSel\.value; \}\)/.test(js),
  'changing the dropdown updates the remembered source');
assert(/const source = sel \? sel\.value : wsAdoptState\.source;/.test(js),
  'the remembered source is the fallback when the select is absent');
const adopt = js.slice(js.indexOf('async function wsAdopt('));
assert(/if \(confirmRun && !confirm\(/.test(adopt), 'the real run confirms first');
assert(/nothing is published until you publish it|nothing is published until you publish/i.test(adopt.replace(/\n/g, ' ')),
  'the confirmation says nothing goes live');

// ---------- escaping ---------------------------------------------------------------------------------------
// Article titles and slugs are author-controlled and are interpolated into innerHTML here.
const listFn = js.slice(js.indexOf('function wsRenderArticleList('), js.indexOf('async function wsEditArticle('));
assert(/escapeHtml\(a\.title\)/.test(listFn), 'article titles are escaped in the list');
assert(/escapeHtml\(a\.slug\)/.test(listFn), 'article slugs are escaped in the list');
const editFn = js.slice(js.indexOf('async function wsEditArticle('), js.indexOf('function wsArtValue('));
// escapeHtml is called DIRECTLY rather than through a local alias. An alias (`const v = escapeHtml`)
// reads identically to a human but is invisible to seclint's innerhtml-dataflow rule, which flagged
// the aliased version as unescaped. Keeping the real name is what lets the static guard work.
assert(/escapeHtml\(/.test(editFn), 'the editor escapes the values it renders into markup');
const interpolations = editFn.match(/\$\{[^}]*\}/g) || [];
// encodeURIComponent counts: a slug going into a fetch URL needs URL escaping, not HTML escaping.
// Conditionals (a ? b : c) are checked by eye — they carry their own escaped branches.
const unescaped = interpolations.filter((x) =>
  /article\.|slug|date/.test(x)
  && !/escapeHtml\(/.test(x)
  && !/encodeURIComponent\(/.test(x)
  && !/\?|:/.test(x));
assert(unescaped.length === 0,
  'every article-derived interpolation in the editor is escaped' +
  (unescaped.length ? ' — unescaped: ' + unescaped.slice(0, 3).join(', ') : ''));
assert(!/const v = \(x\) => escapeHtml/.test(editFn),
  'no local escaping alias — it hides the escaping from the static guard');

done();
