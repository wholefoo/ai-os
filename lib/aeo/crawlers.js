// lib/aeo/crawlers.js
// ============================================================
//  AI-crawler robots.txt gate check + allowlist generator. If an answer engine's crawler
//  is blocked in robots.txt, that engine can't read the site — so it can't cite it. This
//  is a deterministic fetch+parse (no LLM, free, free-audit-safe). Ported + expanded from
//  aiserp's crawler.py (AI_CRAWLERS + _check_robots_txt) with a more correct robots parse
//  (a UA's own block wins over the wildcard block).
// ============================================================

const { safeFetch } = require('../net/safe-fetch');

const UA = 'AI-OS-AEO/1.0';

// The bots answer engines actually use today (read/cite + training).
const AI_CRAWLERS = [
  { ua: 'GPTBot', vendor: 'OpenAI — ChatGPT training' },
  { ua: 'OAI-SearchBot', vendor: 'OpenAI — ChatGPT Search' },
  { ua: 'ChatGPT-User', vendor: 'OpenAI — ChatGPT live browse' },
  { ua: 'ClaudeBot', vendor: 'Anthropic — Claude training' },
  { ua: 'Claude-Web', vendor: 'Anthropic — Claude live browse' },
  { ua: 'anthropic-ai', vendor: 'Anthropic' },
  { ua: 'PerplexityBot', vendor: 'Perplexity — index' },
  { ua: 'Perplexity-User', vendor: 'Perplexity — live browse' },
  { ua: 'Google-Extended', vendor: 'Google — Gemini & AI Overviews' },
  { ua: 'Applebot-Extended', vendor: 'Apple Intelligence' },
  { ua: 'CCBot', vendor: 'Common Crawl — trains many LLMs' },
  { ua: 'Amazonbot', vendor: 'Amazon — Alexa/AI' },
  { ua: 'Bytespider', vendor: 'ByteDance/TikTok AI' },
  { ua: 'meta-externalagent', vendor: 'Meta AI' },
];

// Parse robots.txt into user-agent blocks: [{ agents:[lc], disallowAll:bool }].
function parseBlocks(robots) {
  const blocks = [];
  let cur = null, sawRule = false;
  for (let raw of String(robots || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      if (!cur || sawRule) { cur = { agents: [], disallowAll: false }; blocks.push(cur); sawRule = false; }
      cur.agents.push(ua[1].trim().toLowerCase());
      continue;
    }
    const dis = line.match(/^disallow:\s*(.*)$/i);
    const allow = line.match(/^allow:\s*(.*)$/i);
    if ((dis || allow) && cur) {
      sawRule = true;
      if (dis && dis[1].trim() === '/') cur.disallowAll = true;
    }
  }
  return blocks;
}

// A UA is blocked if its OWN block disallows '/'; if it has no own block, the '*' block applies.
function isBlocked(blocks, ua) {
  const uaLc = ua.toLowerCase();
  let ownBlocked = null, wildcardBlocked = false;
  for (const b of blocks) {
    if (b.agents.includes(uaLc)) ownBlocked = ownBlocked || b.disallowAll;
    else if (b.agents.includes('*') && b.disallowAll) wildcardBlocked = true;
  }
  return ownBlocked !== null ? ownBlocked : wildcardBlocked;
}

// Check a domain's robots.txt for AI-crawler access. Never throws.
async function checkAiCrawlers(domain) {
  const host = String(domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  let robots = '', accessible = false;
  try {
    robots = await safeFetch(`https://${host}/robots.txt`, { userAgent: UA, accept: 'text/plain', maxBytes: 512_000, timeoutMs: 10000 });
    accessible = true;
  } catch { /* no robots / unreachable / non-200 */ }
  const blocks = accessible ? parseBlocks(robots) : [];
  const results = AI_CRAWLERS.map((c) => ({ ...c, blocked: accessible ? isBlocked(blocks, c.ua) : false }));
  const blocked = results.filter((r) => r.blocked);
  return { accessible, hasRobots: accessible, results, blocked, robots: robots.slice(0, 4000) };
}

// A copy-paste robots.txt block that allows every major AI crawler.
function generateRobotsAllowlist() {
  const lines = ['# AI / answer-engine crawler allowlist — lets ChatGPT, Perplexity, Gemini,', '# Claude, etc. read and CITE your content. Append above your existing rules.', ''];
  for (const c of AI_CRAWLERS) lines.push(`User-agent: ${c.ua}`, 'Allow: /', `# ${c.vendor}`, '');
  return lines.join('\n');
}

module.exports = { checkAiCrawlers, generateRobotsAllowlist };
