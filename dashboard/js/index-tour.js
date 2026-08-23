// Externalised from an inline <script> block in index.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

// --- Tour Guide Avatar Logic ---
  const tourGuideData = {
    name: 'Atlas',
    role: 'CEO & Chief Orchestrator',
    greeting: "Hey there! I'm Atlas, the CEO of AI OS Corp. I run a virtual company with 70 AI employees across 11 departments — and you stay in control, approving every important action. Want me to show you around?",
    tours: {
      overview: [
        { msg: "AI OS is a Virtual Corporate Headquarters — imagine a full company staffed by 70 AI agents, each with a name, role, and department. And you stay in the loop: important actions wait for your approval in Auto-Mode.", delay: 0 },
        { msg: "We have 11 departments: Executive, Legal, Engineering, Marketing, Creative, Customer Service, IT, Product, Operations, Knowledge & Records, and a Board of Directors.", delay: 2000 },
        { msg: "Every agent runs on one of 6 AI models across 4 routing tiers — Claude Opus 5 (our default), OpenAI GPT, Gemini, DeepSeek, Grok, and Perplexity. The orchestrator picks the right brain for each task.", delay: 4000 },
        { msg: "Want to hear about a specific department, or should I tell you about our licensing options?", delay: 6000, options: ['Tell me about SEO Agency', 'Creative Studio', 'Licensing options', 'How does pricing work?'] },
      ],
      seo: [
        { msg: "Our SEO Agency is one of the most powerful features. When you audit a domain, I dispatch 5 sub-agents simultaneously:", delay: 0 },
        { msg: "Beacon (Keyword Analysis), a Technical Auditor, a Competitor Analyst, a Content Reviewer, and a Backlink Profiler — all running in parallel.", delay: 2000 },
        { msg: "They generate a composite score out of 100, plus content briefs, a 12-week action calendar, and optimized meta tags. It's what agencies charge $5K-$10K/month for.", delay: 4000 },
        { msg: "Anything else you'd like to know?", delay: 6000, options: ['How does the Virtual HQ work?', 'Tell me about licensing', 'What about Creative Studio?', 'Show me pricing'] },
      ],
      creative: [
        { msg: "The Creative Studio is powered by Gemini Omni — Google's multimodal generation model. We have 5 creative agents:", delay: 0 },
        { msg: "Muse (Creative Director), Pixel (UI/UX), Reel (Video Producer), Vertex (3D Artist), and Sonance (Audio Engineer). Plus Palette for brand design.", delay: 2000 },
        { msg: "You can generate videos, images, audio, thumbnails, and social clips — all from text prompts. Every output gets SynthID watermarked for provenance.", delay: 4000 },
        { msg: "We also have YouTube Intelligence — Claude Vision analyzes video frames to extract what speakers show on screen, not just what they say.", delay: 6000, options: ['Tell me about licensing', 'How about SEO Agency?', 'Show me pricing', 'What models do you use?'] },
      ],
      licensing: [
        { msg: "AI OS follows the open-core model — like n8n or ViaSocket. The Community edition is free and open-source. You self-host on your own infrastructure.", delay: 0 },
        { msg: "Community is free — 19 agents across 6 departments, full source code, community support. Perfect for individuals and small teams.", delay: 2000 },
        { msg: "Business license is a one-time $1,997 — unlocks all 70 agents, all production tools, and self-instance theming so you can brand your own private instance with your name, logo, and colors.", delay: 4000 },
        { msg: "Enterprise license is $4,997 one-time — everything in Business plus SSO/SAML and advanced security, custom agent development, and the self-improving platform with agent builder.", delay: 6000 },
        { msg: "Neither license has recurring fees — both include lifetime software updates.", delay: 8000 },
        { msg: "Prefer done-for-you? Our Managed Website is $997 one-time setup plus $250/month — we build and host your site on our VPS, with a scoped client dashboard. No self-hosting needed.", delay: 10000, options: ['How do I get started?', 'What\'s included exactly?', 'Show me the pricing page', 'Back to overview'] },
      ],
      pricing: [
        { msg: "We keep it simple — open-source core with commercial licenses:", delay: 0 },
        { msg: "Free Demo — try AI OS in your browser at aiosorchestrationlab.com. Limited access, no self-hosting needed.", delay: 1500 },
        { msg: "Community — free, open-source, self-hosted. 19 agents, 6 departments, SEO Agency, skills and pipelines. Full source code access.", delay: 3000 },
        { msg: "Business — $1,997 one-time license. All 70 agents, all production tools, and self-instance theming to brand your own private instance.", delay: 4500 },
        { msg: "Enterprise — $4,997 one-time license. Everything in Business plus SSO/SAML and advanced security, custom agents, and 25 AI business clones.", delay: 6000 },
        { msg: "Managed Website (done-for-you) — $997 one-time setup plus $250/month hosting & maintenance. We build and host your site on our VPS with a scoped client dashboard.", delay: 7500, options: ['How do I self-host?', 'Tell me more about features', 'Back to overview'] },
      ],
      models: [
        { msg: "We route 6 AI models across 4 tiers for optimal cost and quality:", delay: 0 },
        { msg: "Strategic tier — Claude Opus 5 at xhigh effort. That's me and the C-Suite: deep reasoning for architecture and critical decisions. Opus 5 is our default brain.", delay: 1500 },
        { msg: "Professional tier — most agents for research, coding, writing, legal, and support. We can route to OpenAI GPT for alternative reasoning and code generation.", delay: 3000 },
        { msg: "Creative tier — Gemini for video, image, and audio. Economy tier — DeepSeek for fast, low-cost bulk processing.", delay: 5000 },
        { msg: "For live data we tap Grok (xAI) for real-time web search and Perplexity for grounded search with citations. The orchestrator picks the right model for each task automatically.", delay: 7000, options: ['Tell me about SEO', 'Creative Studio', 'Licensing options', 'Pricing'] },
      ],
      apply: [
        { msg: "To get started, scroll down to the pricing section and pick your plan, or I can take you there now.", delay: 0 },
        { msg: "The Community edition is free and open-source — clone the repo and self-host. Business and Enterprise licenses are one-time purchases through Stripe checkout.", delay: 2000 },
        { msg: "After purchase, you deploy on your own infrastructure — the license is perpetual, with no recurring fees.", delay: 4000, options: ['Take me to pricing', 'Back to overview', 'What\'s included?'] },
      ],
    },
    quickReplies: {
      'Tell me about SEO Agency': 'seo',
      'How about SEO Agency?': 'seo',
      'Creative Studio': 'creative',
      'What about Creative Studio?': 'creative',
      'Tell me about licensing': 'licensing',
      'Licensing options': 'licensing',
      'Tell me more about features': 'overview',
      'How does the Virtual HQ work?': 'overview',
      'Back to overview': 'overview',
      'How does pricing work?': 'pricing',
      'Show me pricing': 'pricing',
      'Show me the pricing page': 'pricing',
      'What models do you use?': 'models',
      'I want a license': 'apply',
      'How do I apply?': 'apply',
      'What\'s included exactly?': 'licensing',
      'What\'s included?': 'licensing',
      'Take me to pricing': '_scroll_pricing',
    },
    fallbacks: [
      "Great question! I'd love to help with that. For detailed answers, you can log into the dashboard or check our docs at /docs.",
      "That's a bit outside my tour script, but the full platform has the answer. Want me to tell you about our features, pricing, or licensing instead?",
      "I'm best at giving tours! Try asking about the SEO Agency, Creative Studio, Virtual HQ, or Licensing options.",
    ],
  };

  let tourOpen = false;
  let tourTyping = false;

  function toggleTourGuide() {
    tourOpen = !tourOpen;
    const panel = document.getElementById('tourPanel');
    const fab = document.getElementById('tourFab');
    panel.classList.toggle('open', tourOpen);
    fab.classList.toggle('active', tourOpen);

    if (tourOpen && document.getElementById('tourMessages').children.length === 0) {
      addBotMessage(tourGuideData.greeting, ['Give me the tour!', 'Tell me about pricing', 'Licensing options', 'What models do you use?']);
    }
  }

  function addBotMessage(text, options) {
    const container = document.getElementById('tourMessages');
    const bubble = document.createElement('div');
    bubble.className = 'tour-msg tour-msg-bot';
    bubble.innerHTML = '<span class="tour-msg-avatar"><div class="avatar-atlas" style="width:24px;height:24px;"><div class="avatar-face"><div class="eye eye-l"></div><div class="eye eye-r"></div><div class="mouth"></div></div></div></span><div class="tour-msg-text">' + text + '</div>';
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;

    if (options) {
      setTimeout(() => setTourOptions(options), 300);
    }
  }

  function addUserMessage(text) {
    const container = document.getElementById('tourMessages');
    const bubble = document.createElement('div');
    bubble.className = 'tour-msg tour-msg-user';
    bubble.innerHTML = '<div class="tour-msg-text">' + text + '</div>';
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const container = document.getElementById('tourMessages');
    const typing = document.createElement('div');
    typing.className = 'tour-msg tour-msg-bot tour-typing';
    typing.id = 'tourTypingIndicator';
    typing.innerHTML = '<span class="tour-msg-avatar"><div class="avatar-atlas" style="width:24px;height:24px;"><div class="avatar-face"><div class="eye eye-l"></div><div class="eye eye-r"></div><div class="mouth"></div></div></div></span><div class="tour-msg-text"><span class="tour-dots"><span>.</span><span>.</span><span>.</span></span></div>';
    container.appendChild(typing);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('tourTypingIndicator');
    if (el) el.remove();
  }

  function setTourOptions(options) {
    const container = document.getElementById('tourOptions');
    container.innerHTML = options.map(opt =>
      '<button class="tour-option" onclick="handleTourOption(\'' + opt.replace(/'/g, "\\'") + '\')">' + opt + '</button>'
    ).join('');
  }

  function handleTourOption(option) {
    addUserMessage(option);
    document.getElementById('tourOptions').innerHTML = '';

    const tourKey = tourGuideData.quickReplies[option];

    if (tourKey === '_scroll_pricing') {
      addBotMessage("Taking you to the pricing section now!");
      setTimeout(() => document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' }), 500);
      return;
    }

    if (tourKey && tourGuideData.tours[tourKey]) {
      playTour(tourKey);
    } else {
      const fallback = tourGuideData.fallbacks[Math.floor(Math.random() * tourGuideData.fallbacks.length)];
      showTyping();
      setTimeout(() => {
        hideTyping();
        addBotMessage(fallback, ['Give me the tour!', 'Pricing', 'Licensing options']);
      }, 1000);
    }
  }

  function playTour(tourKey) {
    const steps = tourGuideData.tours[tourKey];
    if (!steps) return;

    showTyping();
    steps.forEach((step, i) => {
      setTimeout(() => {
        hideTyping();
        if (i < steps.length - 1) showTyping();
        addBotMessage(step.msg, step.options || null);
      }, step.delay + 1000);
    });
  }

  function sendTourMessage() {
    const input = document.getElementById('tourInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addUserMessage(text);
    document.getElementById('tourOptions').innerHTML = '';

    const lower = text.toLowerCase();
    let matched = null;
    if (lower.includes('seo') || lower.includes('audit')) matched = 'seo';
    else if (lower.includes('creative') || lower.includes('video') || lower.includes('omni')) matched = 'creative';
    else if (lower.includes('license') || lower.includes('licensing')) matched = 'licensing';
    else if (lower.includes('price') || lower.includes('pricing') || lower.includes('cost') || lower.includes('how much')) matched = 'pricing';
    else if (lower.includes('model') || lower.includes('opus') || lower.includes('tier')) matched = 'models';
    else if (lower.includes('apply') || lower.includes('sign up') || lower.includes('join')) matched = 'apply';
    else if (lower.includes('tour') || lower.includes('overview') || lower.includes('what is') || lower.includes('tell me')) matched = 'overview';
    else if (lower.includes('youtube') || lower.includes('video intel')) matched = 'creative';
    else if (lower.includes('legal') || lower.includes('compliance') || lower.includes('contract')) matched = 'licensing';
    else if (lower.includes('hq') || lower.includes('headquarter') || lower.includes('department')) matched = 'overview';

    showTyping();
    setTimeout(() => {
      hideTyping();
      if (matched) {
        playTour(matched);
      } else {
        const fallback = tourGuideData.fallbacks[Math.floor(Math.random() * tourGuideData.fallbacks.length)];
        addBotMessage(fallback, ['Give me the tour!', 'Pricing', 'Licensing options', 'SEO Agency']);
      }
    }, 800);
  }

  // Auto-show tour guide after 5 seconds with a subtle bounce
  setTimeout(() => {
    const fab = document.getElementById('tourFab');
    if (fab && !tourOpen) fab.classList.add('attention');
  }, 5000);
