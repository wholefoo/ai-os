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
// Bounded by the function's own end, not by the next section header: the site content settings
// panel now sits between delete and adoption, and a header-bounded slice silently widened to cover it.
const fnBody = (name) => {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const next = js.slice(i + 1).search(/\n(?:async )?function |\n\/\/ -{6,}/);
  return js.slice(i, next < 0 ? js.length : i + 1 + next);
};
const del = fnBody('wsDeleteArticle');
assert(del.length > 100 && !/wsRenderHubSettings|wsSaveHubSettings/.test(del), 'the delete function was bounded to itself');
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
  // The whole function, not a fixed 2000-character window: wsSaveArticle grew past that when the hub
  // fields were added, and its fetchJSON call fell outside the slice — a test failure with no defect.
  const src = fnBody(fn);
  assert(src.length > 100, fn + ' was located');
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

// ---------- the editor must RUN, not just look right as text ----------------------------------------
// A local `v` escaping alias was forced out of the editor by the assertion above. Its definition went
// and ONE call site — `v(article.slug)` in the header of an existing entry — was left behind. `v` was
// defined nowhere, so opening ANY existing article threw a ReferenceError and left the editor on
// "Loading…" in production, while every regex check here stayed green. Found by rendering the editor
// in a browser.
//
// A static "is every helper defined?" check was tried first and was wrong BOTH ways: it treated a
// LOCAL `const v` inside a function in clones.js as a definition (so it missed the real bug), and it
// flagged words inside template text like "page(s)" as calls. So this EXECUTES the real functions
// against a permissive fake DOM instead: any ReferenceError or TypeError fails the test.
{
  const vm = require('vm');
  const el = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'innerHTML' || k === 'value' || k === 'textContent' ? (t[k] || '')
      : k === 'querySelectorAll' ? () => [] : k === 'classList' ? { toggle() {}, add() {}, remove() {} }
      : k === 'style' || k === 'dataset' ? (t[k] = t[k] || {}) : k in t ? t[k] : () => el()),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const panes = {};
  const documentStub = {
    getElementById: (id) => (panes[id] = panes[id] || el()),
    querySelectorAll: () => [], querySelector: () => null, createElement: () => el(), addEventListener() {},
  };
  const now = '2026-09-18T12:00:00.000Z';
  const existing = { slug: 'talk', title: 'Talk', excerpt: '', html: '<p>notes</p>', kind: 'video', youtubeId: 'dQw4w9WgXcQ',
    duration: '12:34', tags: ['civic'], featured: true, source: { url: 'https://example.com', name: 'Ex' }, draft: false, publishedAt: now };
  const ctx = {
    console, setTimeout, clearTimeout, confirm: () => true, alert() {},
    document: documentStub, window: {}, location: { hash: '' },
    // The only globals supplied are ones app.js provably defines at top level; everything the editor
    // itself calls must be defined by web-studio.js or it throws.
    escapeHtml: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'),
    fetchJSON: async (url) => (/\/articles\/[^/]+$/.test(url) ? { article: existing }
      : { articles: [{ ...existing, words: 1, readingMinutes: 1 }], hasPlan: true, prefix: '/article', hub: { newsletter: {} } }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  let loadErr = null;
  try { vm.runInContext(js, ctx, { filename: 'web-studio.js' }); } catch (e) { loadErr = e; }
  assert(!loadErr, 'web-studio.js loads in the harness: ' + (loadErr && loadErr.message));
  ctx.wsState = ctx.wsState || {}; ctx.wsState.currentId = 'site-1';
  ctx.wsHint = () => {}; ctx.wsRefreshPreview = () => {};
  const runs = [
    ['wsRenderArticleList (list view)', async () => { await ctx.wsLoadArticles(); }],
    ['wsEditArticle on an EXISTING entry', async () => { await ctx.wsEditArticle('talk'); }],
    ['wsEditArticle for a new video', async () => { await ctx.wsEditArticle(null, 'video'); }],
    ['wsRenderHubSettings', async () => { ctx.wsRenderHubSettings(); }],
  ];
  (async () => {
    for (const [label, fn] of runs) {
      let err = null;
      try { await fn(); } catch (e) { err = e; }
      assert(!err, label + ' runs without throwing' + (err ? ' — ' + err.name + ': ' + err.message : ''));
    }
    const editor = String((panes.wsArticlesPane || {}).innerHTML || '');
    done();
  })();
}
