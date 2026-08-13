// Externalised from an inline <script> block in buy.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

var canceled = new URLSearchParams(location.search).get('canceled');
  var msg = document.getElementById('msg');
  function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); } catch (e) { return cur + ' ' + n; } }
  (async function () {
    try {
      var data = await (await fetch('/api/commerce/offers')).json();
      var o = (data.offers || [])[0];
      if (!o) { document.getElementById('title').textContent = 'Not available'; document.getElementById('desc').textContent = 'This offer is not currently available.'; return; }
      document.getElementById('title').textContent = o.name;
      document.getElementById('desc').textContent = o.description;
      document.getElementById('setup').textContent = money(o.setup_fee, o.currency);
      document.getElementById('monthly').textContent = money(o.monthly_fee, o.currency);
      document.getElementById('price').style.display = 'flex';
      document.getElementById('form').style.display = 'block';
      document.getElementById('fine').textContent = 'After payment you’ll set a password and get your own dashboard to build & manage your site. Cancel anytime.';
      if (canceled) { msg.className = 'msg err'; msg.textContent = 'Checkout canceled — you have not been charged.'; }
    } catch (e) { document.getElementById('title').textContent = 'Something went wrong'; }
  })();
  document.getElementById('go').addEventListener('click', async function () {
    var email = (document.getElementById('email').value || '').trim();
    var name = (document.getElementById('name').value || '').trim();
    msg.className = 'msg';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = 'msg err'; msg.textContent = 'Enter a valid email.'; return; }
    var btn = document.getElementById('go'); btn.disabled = true; msg.textContent = 'Redirecting to secure checkout…';
    try {
      var r = await fetch('/api/commerce/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, name: name }) });
      var d = await r.json();
      if (!r.ok || d.error || !d.url) { msg.className = 'msg err'; msg.textContent = d.error || ('Error ' + r.status); btn.disabled = false; return; }
      location.href = d.url;
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'Network error — try again.'; btn.disabled = false; }
  });
