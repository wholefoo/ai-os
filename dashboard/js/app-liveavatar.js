// Externalised from an inline <script> block in app.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (type="module"), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

import * as LiveAvatarSDK from '/vendor/liveavatar-sdk.esm.js';
    window.LiveAvatarSDK = LiveAvatarSDK;
    window.dispatchEvent(new Event('liveavatar-sdk-ready'));
