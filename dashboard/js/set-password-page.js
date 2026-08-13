// Externalised from an inline <script> block in set-password.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var msg = document.getElementById('msg');
  if (!token) { msg.className = 'msg err'; msg.textContent = 'Missing or invalid setup link.'; document.getElementById('go').disabled = true; }
  document.getElementById('go').addEventListener('click', async function () {
    var pw = document.getElementById('pw').value, pw2 = document.getElementById('pw2').value;
    msg.className = 'msg';
    if (pw.length < 8) { msg.className = 'msg err'; msg.textContent = 'Password must be at least 8 characters.'; return; }
    if (pw !== pw2) { msg.className = 'msg err'; msg.textContent = 'Passwords do not match.'; return; }
    var btn = document.getElementById('go'); btn.disabled = true; msg.textContent = 'Setting your password…';
    try {
      var r = await fetch('/api/auth/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ token: token, password: pw }) });
      var data = await r.json();
      if (!r.ok || data.error) { msg.className = 'msg err'; msg.textContent = data.error || ('Error ' + r.status); btn.disabled = false; return; }
      msg.className = 'msg ok'; msg.textContent = 'Done — taking you to your dashboard…';
      location.href = data.redirect || '/app';
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'Network error — try again.'; btn.disabled = false; }
  });
