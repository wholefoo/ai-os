// lib/handbooks/schema.js — parse and validate an agent handbook.
//
// A handbook IS the agent's `.claude/agents/<name>.md` file. There is deliberately no second
// artifact type: that file is already the system prompt (`loadAgentPrompt` strips the frontmatter
// and sends the whole body), already counted in product canon, and already what the orchestrator
// dispatches to. A parallel "handbook" registry would drift from the agent corpus, which is the
// exact failure this design exists to remove.
//
// The direction of travel, from .magent/vault/wiki/agent-handbooks-design.md:
//
//   A PROCEDURE says which button to press next. A STANDARD says what good looks like and what is
//   out of bounds. Only the first one rots when the model improves.
//
// So this module validates the presence and shape of STANDARDS. It has no opinion on how an agent
// reaches its outcome, and must never grow one.
//
// Pure: parsing and rules. No I/O — callers read the files. That keeps it testable without a
// fixture directory and keeps the validator honest about what it actually checked.

'use strict';

const catalog = require('../library/catalog');

/** The five archetypes. A mode of work, orthogonal to WHICH department an agent belongs to. */
const ARCHETYPES = Object.freeze(['prototyper', 'builder', 'sweeper', 'grower', 'maintainer']);

/**
 * Shared business memory an agent can declare it works from — key 5 of "The Five Keys to Briefing
 * Your AI Employee" (brand voice, mission, ICP, product details, what worked before).
 *
 * The library stores are IMPORTED from lib/library/catalog rather than restated, so a store added
 * or renamed there cannot leave a stale vocabulary here. The rest name real surfaces:
 *   org-profile     the company's identity + boundary policy (lib/org/profile.js), merged at use
 *   canonical-facts the canonical-fact shelf — the one place counts and prices are true
 *   vault:*         the Memory Vault's own folders
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * DECLARING MEMORY DOES NOT GRANT ACCESS. This is the opposite failure to `gates:` and just as
 * dangerous. A gate that names nothing enforces nothing; a memory line that LOOKS like a grant
 * would have someone add `library:org-docs` to a handbook and assume the agent may now read
 * personnel contributions. It may not. Reads are governed by the catalog's `readers` allowlist and
 * `operatorMayOverride`, in code, at read time — this field only says what the agent SHOULD be
 * grounded in when it is permitted. A handbook cannot widen its own access.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
const MEMORY_SOURCES = Object.freeze([
  'org-profile',
  'canonical-facts',
  ...catalog.VALID_STORES.map((s) => `library:${s}`),
  'vault:wiki', 'vault:raw', 'vault:outputs',
]);

/**
 * The tool vocabulary a handbook may name — key 4 of the five keys (access to tools and files).
 *
 * These are Claude Code's own tool names, and that is the entire justification for the list. An
 * agent handbook IS a `.claude/agents/<name>.md` file, which is Claude Code's agent-definition
 * format; when one of these agents is dispatched THERE, the harness grants exactly the tools named
 * here and nothing else. So this vocabulary is real, checkable, and has one authority.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * AND IT IS STILL A DECLARATION, NOT A GRANT — on the path this platform uses. `executeAgent`
 * grants no per-agent tools at all: the only runtime tool surface a dispatched agent reaches is
 * `buildMcpToolset()`, whose names are generated per connected integration (`mcpSafeName`) and can
 * never match a token here. Three consumers read this field — the `agentConcepts` display string,
 * key-4 coverage below, and the maintainer-with-a-shell rule in tools/test-handbooks.js — and not
 * one of them grants anything. Same discipline as MEMORY_SOURCES above: a handbook cannot widen its
 * own access by editing a line of YAML.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHY A CLOSED LIST, when the field grants nothing either way. Because the corpus had TWO
 * vocabularies and only this one was true anywhere (design doc §9 item 13). 45 agents named real
 * Claude Code tools; 23 named invented capability labels — `file-write`, `content-creation`,
 * `code-execute`, `embedding-search` — that resolve to nothing in either runtime. That was not a
 * harmless documentation wart: Claude Code surfaces this field in its agent roster, so those 23
 * advertised tools that would not be granted if anyone dispatched them there. One label,
 * `social-post`, named a capability the platform explicitly does NOT have — the same fiction §9
 * item 12 caught `marketing-hub` believing about itself.
 *
 * Service dependencies do NOT belong here and were not moved here. Every converted agent already
 * stated its real dependency (DataForSEO, Firecrawl, Gemini Omni, Blender, openpyxl, the vault) in
 * its `## What good looks like` standard, which is prose the model actually reads. That is the
 * right home for intent; this field is for the tool names a harness can hand over.
 *
 * Adding one: it must be a tool Claude Code actually ships. That is the whole bar.
 */
const RUNTIME_TOOLS = Object.freeze([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit',
]);

/**
 * Ceiling on a handbook's body, in lines.
 *
 * This is a BUDGET, not a limit. The body is the system prompt on every single call that agent
 * makes, so every line added is paid for on every future call, forever — the same argument as the
 * CAPS in lib/business-clone/persona.js. Criteria earn their place or they come out.
 */
const MAX_BODY_LINES = 120;

/** Minimum checkable criteria for a handbook that claims to have a standard at all. */
const MIN_CRITERIA = 2;

const SECTION = {
  criteria: 'What good looks like',
  guardrails: 'Never without asking',
  gotchas: 'Gotchas',
};

/**
 * Split frontmatter from body. Mirrors loadAgentPrompt's regex so the two cannot disagree.
 *
 * CRLF is normalised HERE, once, so nothing downstream has to think about it. Some agent files are
 * CRLF and some are LF — this is a Windows repo — and the difference is invisible until it is not:
 * a JS regex treats `\r` as a line terminator, so in `/^\s*[-*]\s+(.*)$/` the `.*` stops before it
 * and `$` then fails to match. The heading above the bullets still matched, because that comparison
 * is `.trim()`ed. The result was a file whose criteria all parsed as ZERO while looking perfect in
 * an editor. It surfaced loudly only because a section that exists with no bullets is an error; a
 * handbook with no section at all would have reported "unconverted" and said nothing.
 */
function split(content) {
  const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: text.trim(), hasFrontmatter: false };
  return { frontmatter: m[1], body: m[2].trim(), hasFrontmatter: true };
}

/**
 * Minimal YAML reader for the flat `key: value` and `key: [a, b]` frontmatter these files use.
 *
 * Deliberately not a YAML dependency: the agent frontmatter has been flat since the corpus began,
 * and adding a parser to read six keys would be a new supply-chain surface for no gain. If a
 * handbook ever needs nesting, that is the moment to reach for a real parser — not before.
 */
function parseFrontmatter(fm) {
  const out = {};
  const lines = String(fm || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();

    // A key with nothing after the colon may open a multi-line YAML list:
    //   triggers:
    //     - source added
    //     - sync interval
    // Reading only the inline form made this module report those agents as having NO tools, which
    // under-counted key 4 (access to tools and files) by a third of the corpus — a wrong number in
    // the report that plans the next phase. The parser has to match the files that exist, not the
    // ones that would be tidier.
    //
    // `tools:` was the original example here and is no longer: §9 item 13 converted all 23 of its
    // multi-line users to the inline form, because the two FORMS had come to carry two different
    // VOCABULARIES and only one was real (see RUNTIME_TOOLS). The form itself was never the problem
    // and is still load-bearing — 18 agents write `triggers:` this way.
    if (value === '') {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = lines[j].match(/^\s+-\s+(.*)$/);
        if (!m) break;
        const item = m[1].trim().replace(/^['"]|['"]$/g, '');
        if (item) items.push(item);
      }
      if (items.length) { out[key] = items; i = j - 1; continue; }
    }
    // A bracketed list may carry a trailing comment — `gates: []   # nothing irreversible here` —
    // and that comment is the most valuable part of an EMPTY list, because it records that the
    // question was considered rather than skipped. Matched by the brackets and the remainder
    // discarded, rather than stripping `#` from every value: a description containing "#1" or a
    // colour like "#ef4444" is ordinary in this corpus and must survive.
    const list = value.match(/^\[(.*?)\]/);
    if (list) {
      out[key] = list[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      out[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

/** The bullet lines under `## <heading>`, or [] when the section is absent. */
function sectionBullets(body, heading) {
  const lines = String(body || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;                    // next section
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m && m[1].trim()) { out.push(m[1].trim()); continue; }
    if (!line.trim()) continue;                       // blank line inside a list
    // A wrapped continuation JOINS the bullet above it. Skipping it instead silently truncated every
    // multi-line criterion at its first line — and criteria in this corpus wrap constantly, so a
    // grader was being handed "Not a search snippet, not a" and asked to judge against it. Nothing
    // failed; the content just quietly halved. Counting bullets never showed it, which is why this
    // surfaced only when the TEXT was read for the first time in P2.
    if (/^\s+\S/.test(line)) {
      if (out.length) out[out.length - 1] += ' ' + line.trim();
      continue;
    }
    // Anything else ENDS the list: a `DONE WHEN:` line, a paragraph, a leftover `RULES:` block.
    // Without this the list ran to the next `##`, so bullets belonging to a different part of the
    // file counted as criteria — `safety` reported 10 when it had 5, because an old RULES block sat
    // between the criteria and the next heading. A criteria count is what P1's progress is measured
    // by, so an over-count is a wrong number in the report that plans the work.
    break;
  }
  return out;
}

/**
 * Does this line state a checkable standard rather than a step to perform?
 *
 * Honest about its own limits: this is a heuristic over wording, not comprehension. It catches the
 * common way a procedure sneaks back in — an imperative verb opening the line ("Research the
 * competitors", "Then write the summary") — because that is the failure mode observed in the 18
 * skills that carry a `## Process`. It cannot catch a well-disguised procedure, and it is not
 * supposed to: it is a lint, and the reviewer is the real check.
 *
 * Kept as a small explicit list rather than a general NLP guess, so that when it is wrong a person
 * can see exactly why and fix it in one line.
 */
const PROCEDURAL_OPENERS = Object.freeze([
  'run', 'call', 'open', 'click', 'then', 'next', 'first', 'start by', 'begin by',
  'research', 'gather', 'collect', 'gather up', 'write', 'draft', 'create', 'generate',
  'analyze', 'analyse', 'review', 'check the', 'search', 'scan', 'fetch', 'use the',
  'step ', 'finally',
]);

function looksProcedural(line) {
  const s = String(line || '').trim().toLowerCase();
  if (/^\d+[.)]\s/.test(s)) return true;              // a numbered step
  return PROCEDURAL_OPENERS.some((v) => s.startsWith(v));
}

/**
 * Validate one handbook.
 *
 * @param {string} content   raw file contents
 * @param {object} ctx
 * @param {string[]} ctx.gateIds     every action id the approval registry knows (ACTION_RISK keys)
 * @param {string[]} ctx.rubricKeys  every key in verification-rubrics.yaml
 * @returns {{ok: boolean, errors: string[], warnings: string[], meta: object}}
 *
 * Errors BLOCK: they mean the handbook lies about something checkable — a gate that does not exist,
 * an archetype nothing understands. Warnings do not block: they are drift signals for a human.
 */
function validate(content, { gateIds = [], rubricKeys = [] } = {}) {
  const errors = [];
  const warnings = [];
  const { frontmatter, body, hasFrontmatter } = split(content);
  const meta = parseFrontmatter(frontmatter);

  if (!hasFrontmatter) errors.push('no YAML frontmatter — loadAgentPrompt would send the whole file, header and all, as the system prompt');
  if (!meta.name) errors.push('frontmatter is missing `name`');
  if (!meta.description) errors.push('frontmatter is missing `description` — it is what the orchestrator routes on');

  // --- archetype: a known mode of work, or nothing ------------------------------------------------
  const archetypes = Array.isArray(meta.archetype) ? meta.archetype : (meta.archetype ? [meta.archetype] : []);
  for (const a of archetypes) {
    if (!ARCHETYPES.includes(a)) errors.push(`unknown archetype "${a}" — expected one of ${ARCHETYPES.join(', ')}`);
  }

  // --- gates: MUST name a real enforced action ----------------------------------------------------
  // The whole point of the `gates:` key. A guardrail that exists only as prose is a suggestion to a
  // language model; naming an id that the approval registry does not know is worse than naming none,
  // because it reads like enforcement in review and enforces nothing at runtime.
  // `gates: []` is a DECISION — "I considered what this agent could do irreversibly, and nothing
  // qualifies". An absent `gates:` key is an OMISSION — nobody has looked. They must not read the
  // same, or a corpus of 68 unconsidered agents reports as fully guard-railed. Same reasoning as an
  // allowlist elsewhere in this codebase: explicit-empty and missing are different states.
  const declaresGates = Object.prototype.hasOwnProperty.call(meta, 'gates');
  const gates = Array.isArray(meta.gates) ? meta.gates : (meta.gates ? [meta.gates] : []);
  for (const g of gates) {
    if (!gateIds.includes(g)) {
      errors.push(`gate "${g}" is not in the approval registry (lib/safety/approval.js ACTION_RISK) — a handbook cannot promise a guardrail the server does not enforce`);
    }
  }

  // --- rubric: a real verification key -------------------------------------------------------------
  if (meta.rubric && rubricKeys.length && !rubricKeys.includes(meta.rubric)) {
    errors.push(`rubric "${meta.rubric}" is not a key in .claude/rules/verification-rubrics.yaml`);
  }

  // --- memory: a real shared-business-memory surface -------------------------------------------------
  // Blocking, for the same reason as `gates:`: a source that does not exist reads in review as
  // grounding the agent does not have. See MEMORY_SOURCES for why this is a declaration and not a
  // grant — a handbook cannot widen its own read access.
  const memory = Array.isArray(meta.memory) ? meta.memory : (meta.memory ? [meta.memory] : []);
  for (const m of memory) {
    if (!MEMORY_SOURCES.includes(m)) {
      errors.push(`memory source "${m}" does not exist — expected one of ${MEMORY_SOURCES.join(', ')}`);
    }
  }

  // --- tools: a real tool name, or nothing ---------------------------------------------------------
  // Blocking, for the same reason as `gates:` and `memory:`: a token that names nothing reads in
  // review as capability the agent has. Worse here than for the other two, because Claude Code
  // SURFACES this field in its agent roster — an invented label is advertised to whoever picks an
  // agent, and then silently fails to be granted. See RUNTIME_TOOLS for the two-vocabulary history.
  const toolsDeclared = Array.isArray(meta.tools) ? meta.tools : (meta.tools ? [meta.tools] : []);
  for (const t of toolsDeclared) {
    if (!RUNTIME_TOOLS.includes(t)) {
      errors.push(`tool "${t}" is not a Claude Code tool — expected one of ${RUNTIME_TOOLS.join(', ')}. Name a service dependency (DataForSEO, Firecrawl, Omni, the vault) in the body standard instead; this field is for tool names a harness can actually grant`);
    }
  }

  // --- the standard itself --------------------------------------------------------------------------
  const criteria = sectionBullets(body, SECTION.criteria);
  const guardrails = sectionBullets(body, SECTION.guardrails);
  const hasCriteriaSection = new RegExp(`^##\\s+${SECTION.criteria}\\s*$`, 'im').test(body);

  if (hasCriteriaSection && criteria.length < MIN_CRITERIA) {
    errors.push(`"${SECTION.criteria}" has ${criteria.length} criteria; a standard needs at least ${MIN_CRITERIA} or it is decoration`);
  }
  for (const c of criteria) {
    if (looksProcedural(c)) {
      warnings.push(`criterion reads as a procedure, not a standard: "${c.slice(0, 70)}" — state the END, leave the route to the model`);
    }
  }

  // A guardrail section that names no gate is the decorative case this schema exists to prevent.
  if (guardrails.length && !gates.length) {
    warnings.push(`"${SECTION.guardrails}" lists ${guardrails.length} guardrail(s) but frontmatter declares no \`gates:\` — nothing enforces them`);
  }

  // --- budget ----------------------------------------------------------------------------------------
  const bodyLines = body.split('\n').length;
  if (bodyLines > MAX_BODY_LINES) {
    errors.push(`body is ${bodyLines} lines, over the ${MAX_BODY_LINES}-line budget — this is the system prompt on EVERY call this agent makes`);
  }

  // --- coverage of the five keys ---------------------------------------------------------------------
  // Reported, not enforced. The corpus is mid-migration and an unconverted agent is not a failure;
  // what this gives is an honest per-handbook answer to "which of the five keys does this actually
  // carry?", so progress is measured against the source document rather than against a paraphrase.
  const tools = toolsDeclared;
  const keys = {
    1: /^OUTCOME:/m.test(body),                       // the specific outcome (the job)
    2: criteria.length >= MIN_CRITERIA,               // criteria for success
    3: declaresGates || guardrails.length > 0,        // guardrails — `gates: []` counts, absent does not
    4: tools.length > 0 || /^INPUTS:/m.test(body),    // access to tools and files
    5: memory.length > 0,                             // shared business memory and history
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: {
      name: meta.name || null,
      archetypes,
      gates,
      declaresGates,
      tools,
      memory,
      rubric: meta.rubric || null,
      criteria: criteria.length,
      guardrails: guardrails.length,
      gotchas: sectionBullets(body, SECTION.gotchas).length,
      bodyLines,
      keys,
      keysCovered: Object.values(keys).filter(Boolean).length,
      converted: hasCriteriaSection,   // has this agent been moved to the handbook shape yet?
    },
  };
}

module.exports = {
  ARCHETYPES, MEMORY_SOURCES, RUNTIME_TOOLS, MAX_BODY_LINES, MIN_CRITERIA, SECTION,
  split, parseFrontmatter, sectionBullets, looksProcedural, validate,
};
