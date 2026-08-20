// Externalised from an inline <script> block in contact.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

(function(){
    var form = document.getElementById('supportForm');
    if (!form) return;
    var chat = document.getElementById('supportChat');
    var thread = document.getElementById('sf-thread');
    var replyForm = document.getElementById('sf-replyForm');
    var replyInput = document.getElementById('sf-replyInput');
    var replyBtn = document.getElementById('sf-replyBtn');
    var statusEl = document.getElementById('sf-status');
    var errEl = document.getElementById('sf-error');
    var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    var ticketId = null, email = '', busy = false;

    // Linkify internal site paths (/docs, /docs/<slug>, /#pricing, /free-audit) WITHOUT innerHTML:
    // build text nodes + <a> elements so model output can never inject markup. The href is always a
    // same-origin path captured by the regex (starts with "/"), so javascript:/data: URLs are impossible.
    var PATH_RE = /\/(?:docs(?:\/[a-z0-9-]+)*|#pricing|free-audit)/g;
    function appendLinkified(parent, text){
      var last = 0, m;
      PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(text)) !== null){
        if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement('a');
        a.href = m[0];
        a.textContent = m[0];
        parent.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    }
    function bubble(role, text){
      var d = document.createElement('div');
      d.className = 'support-msg ' + (role === 'user' ? 'user' : 'bot');
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = role === 'user' ? 'You' : 'AI Helpdesk';
      d.appendChild(who);
      if (role === 'user') d.appendChild(document.createTextNode(text)); // user text stays fully inert
      else appendLinkified(d, text);                                     // bot: safe internal-link rendering
      thread.appendChild(d);
      d.scrollIntoView({ block: 'nearest' });
    }
    function typing(on){
      var ex = document.getElementById('sf-typing');
      if (on && !ex){
        var t = document.createElement('div');
        t.className = 'support-typing'; t.id = 'sf-typing';
        t.textContent = 'AI Helpdesk is typing…';
        thread.appendChild(t); t.scrollIntoView({ block: 'nearest' });
      } else if (!on && ex){ ex.remove(); }
    }
    function setBusy(on){
      busy = on;
      if (replyBtn) replyBtn.disabled = on;
      if (replyInput) replyInput.disabled = on;
    }
    async function send(message, subject){
      if (busy) return;
      setBusy(true); typing(true);
      try {
        var r = await fetch('/api/support/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, subject: subject || '', message: message, ticketId: ticketId })
        });
        var data = await r.json().catch(function(){ return {}; });
        typing(false);
        if (data && data.ticketId) ticketId = data.ticketId;
        if (!r.ok || (data && data.error)) {
          bubble('bot', (data && data.error) || 'Something went wrong. Please try again in a moment.');
        } else {
          bubble('bot', data.reply || '');
        }
      } catch (e) {
        typing(false);
        bubble('bot', 'The helpdesk is unreachable right now. Please try again in a moment.');
      }
      setBusy(false);
      if (replyInput) replyInput.focus();
    }

    form.addEventListener('submit', function(e){
      e.preventDefault();
      errEl.hidden = true;
      var em = document.getElementById('sf-email').value.trim();
      var sub = document.getElementById('sf-subject').value.trim();
      var msg = document.getElementById('sf-message').value.trim();
      if (!EMAIL_RE.test(em)) { errEl.textContent = 'Please enter a valid email address.'; errEl.hidden = false; return; }
      if (!msg) { errEl.textContent = 'Please describe the problem to be resolved.'; errEl.hidden = false; return; }
      email = em;
      form.hidden = true;
      chat.hidden = false;
      if (statusEl) statusEl.textContent = 'Replying to ' + email + '. Need a human? Your request is logged for our team.';
      bubble('user', (sub ? '[' + sub + '] ' : '') + msg);
      send(msg, sub);
    });

    replyForm.addEventListener('submit', function(e){
      e.preventDefault();
      var msg = replyInput.value.trim();
      if (!msg || busy) return;
      replyInput.value = '';
      bubble('user', msg);
      send(msg, '');
    });
  })();
