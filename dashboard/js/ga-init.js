// Google Analytics initialiser — externalised from 45 inline <script> blocks (AS-02).
//
// This existed inline on every public page, which is why the CSP needed `script-src 'unsafe-inline'`
// — and that directive is what lets an INJECTED <script> tag execute at all. Moving the code to a
// file it can be served from means `'self'` covers it and the blanket allowance can go.
//
// Loaded SYNCHRONOUSLY (no defer/async) on purpose: it must run after the gtag loader tag that
// precedes it and before anything calls gtag(). Adding defer here would reorder it after parsing
// and silently drop the initial page_view on fast loads.
//
// The measurement ID is the same on every page (G-SMHYRX8D4P), which is what made one shared file
// possible. If a page ever needs a different property, give it its own file rather than
// reintroducing an inline block.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-SMHYRX8D4P');
