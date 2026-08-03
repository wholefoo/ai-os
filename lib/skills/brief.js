// lib/skills/brief.js — parse and validate a skill stated as an OUTCOME BRIEF.
//
// P3 of .magent/vault/wiki/agent-handbooks-design.md: retire the step-runner.
//
// A skill used to be a `## Process` — a numbered list of steps that server.js executed one model call
// at a time, threading each step's output into the next. That shape encodes a procedure, and a
// procedure is exactly what the handbooks direction deletes: it says which button to press next,
// which is the part that rots when the model improves. A brief says what the finished thing must be
// true of, names who owns it, and stops.
//
// Two things found while converting, both of which shaped this module's validation rules and neither
// of which was visible from reading the code:
//
//   1. TEAM NAMES NEVER RESOLVED. Skills declared members as prose — `**Researcher**`, `**Browser
//      Agent**`, `**Safety agent**`, `**Grok Real-Time**` — while agent files are lowercase slugs
//      (`researcher.md`, `browser-agent.md`, `safety.md`, `grok-realtime.md`). loadAgentPrompt does
//      an exact path lookup and executeAgent HARD FAILS on a miss, so every step of every skill that
//      declared a team returned `Agent "X" not found`. The ones that declared none fell back to a
//      literal 'writer' and ran the whole job — keyword research, technical crawl analysis, security
//      assessment — as the writer. So `team:` here is validated against the real agent files, by
//      exact case, and a name that does not resolve is an ERROR, not a warning.
//   2. WINDOWS HID IT. `.claude/agents/Reviewer.md` "exists" on a case-insensitive filesystem and
//      does not on the Linux VPS. A skill could therefore pass locally and fail in production. The
//      slug rule (`^[a-z0-9]+(-[a-z0-9]+)*$`) is checked BEFORE the file lookup for that reason —
//      the lookup alone cannot catch it on the machine where these files are written.
//
// Vocabulary is deliberately shared with lib/handbooks/schema.js — same `## What good looks like`
// heading, same bullet parser, same criteria semantics. That is not tidiness: it means
// rubric.checksFromHandbook() reads a skill brief with no special case, so a skill's criteria and an
// agent's criteria are graded by one engine rather than two that can drift apart.
//
// Pure: parsing and shapes. No I/O and no model calls — the caller owns the filesystem.

'use strict';

const schema = require('../handbooks/schema');

/**
 * Ceiling on team size. Each member is a PARALLEL model call on every run of the skill, so this is a
 * per-run bill, not a style preference. Five is above the largest real team in the corpus (four) and
 * low enough that a fan-out cannot quietly become the most expensive thing the platform does.
 */
const MAX_TEAM = 5;

/** An agent name that will resolve on a case-sensitive filesystem. See note 2 in the header. */
const AGENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Named BRIEF_SECTION rather than SECTION because lib/handbooks/schema.js already exports a SECTION,
// and two modules exporting the same name is an ambiguity waiting for the first barrel import.
const BRIEF_SECTION = {
  criteria: schema.SECTION.criteria,   // shared with handbooks on purpose — see header
  guardrails: 'Guardrails',
  team: 'Team',
  outputs: 'Output',
};

/** Headings that mean this file is still in the retired shape. */
const RETIRED_SECTIONS = Object.freeze(['Process', 'Steps', 'Agents Used', 'Agents Involved']);

/**
 * What a file in .claude/skills/ actually IS. Two kinds live there and always have:
 *
 *   job       — dispatchable to agents. The runner executes it. This is what a brief describes.
 *   reference — a procedure for a PERSON or for Claude Code in-session: the pre-commit gate, the
 *               pre-flight interrogation, a tool's install guide, the maintainer's VPS harvest.
 *
 * The distinction is made explicit rather than inferred because forcing a reference into a brief
 * would require inventing a team for it, and a fabricated team is exactly the kind of claim the
 * handbooks direction exists to delete. A reference legitimately keeps its `## Process` — a
 * procedure aimed at a human is a procedure, and pretending otherwise helps nobody.
 *
 * `job` is the default: a file that says nothing is assumed dispatchable and must prove it validates.
 * Defaulting the other way would let a real skill opt out of every check by omission.
 */
const KINDS = Object.freeze(['job', 'reference']);

/**
 * The declared kind, or 'job' when nothing is declared.
 *
 * Strips a trailing `# comment` because parseFrontmatter deliberately does NOT — a scalar there can
 * legitimately contain `#` (a colour like `#ef4444`, a reference to "#1"), so comment-stripping is
 * the caller's job for the specific keys where a comment is expected. That asymmetry cost a cycle:
 * `kind: reference   # why` parsed as the whole string, matched no known kind, and silently became a
 * job — which is exactly why an unrecognised value is an ERROR in validate() rather than a default.
 * A guard that silently picks the stricter branch on bad input still lies about which branch it took.
 */
function kindOf(meta) {
  const raw = String((meta && meta.kind) || '').replace(/\s+#.*$/, '').trim().toLowerCase();
  // An unrecognised value is returned AS-IS, not coerced to a default, so validate() can name the
  // exact string someone wrote. Coercing here would hide the typo and report a kind nobody chose.
  return raw || 'job';
}

/** The prose under `## <heading>`, up to the next heading, with bullets left intact. */
function sectionText(body, heading) {
  const lines = String(body || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function hasSection(body, heading) {
  return String(body || '').split('\n').some((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
}

/**
 * The agent slug in a team bullet: `- **researcher** — keyword and competitor evidence`.
 *
 * Returns the raw text when there is no bold marker, so a malformed line reaches validation as a
 * BAD NAME rather than vanishing. A team member that silently disappears is the failure mode that
 * made defect 1 invisible for as long as it was.
 */
function teamMember(line) {
  const s = String(line || '').trim();
  const bold = s.match(/^\*\*(.+?)\*\*/);
  const name = bold ? bold[1].trim() : s.split(/[—:-]/)[0].trim();
  const why = s.slice(bold ? bold[0].length : name.length).replace(/^\s*[—:-]\s*/, '').trim();
  return { name, why };
}

/**
 * Parse a skill file into its brief.
 *
 * @param {string} content raw .md
 * @returns {{meta:object, goal:string, criteria:string[], guardrails:string[],
 *            team:Array<{name:string,why:string}>, lead:string|null,
 *            outputs:string[], retired:string[]}}
 */
function parseBrief(content) {
  const { frontmatter, body } = schema.split(content);
  const meta = schema.parseFrontmatter(frontmatter);
  const team = schema.sectionBullets(body, BRIEF_SECTION.team).map(teamMember);
  return {
    meta,
    kind: kindOf(meta),
    dispatchable: kindOf(meta) === 'job',
    goal: sectionText(body, 'Goal'),
    criteria: schema.sectionBullets(body, BRIEF_SECTION.criteria),
    guardrails: schema.sectionBullets(body, BRIEF_SECTION.guardrails),
    hasGuardrailsSection: hasSection(body, BRIEF_SECTION.guardrails),
    team,
    lead: team.length ? team[0].name : null,
    outputs: schema.sectionBullets(body, BRIEF_SECTION.outputs),
    retired: RETIRED_SECTIONS.filter((h) => hasSection(body, h)),
  };
}

/**
 * Validate one skill brief.
 *
 * @param {string} content    raw .md
 * @param {object} ctx
 * @param {string[]} ctx.agentNames  every agent file basename, WITHOUT .md, exactly as on disk
 * @returns {{ok:boolean, errors:string[], warnings:string[], brief:object}}
 *
 * Errors BLOCK: each one means the brief claims something that is not true of the system — a team
 * member that will not load, a retired section the runner no longer executes. Warnings are drift
 * signals for a person.
 */
function validateBrief(content, { agentNames = [] } = {}) {
  const brief = parseBrief(content);
  const errors = [];
  const warnings = [];
  const known = new Set(agentNames);

  // An unrecognised kind is refused rather than defaulted. Defaulting to 'job' would have applied the
  // strict rules and looked safe, but the file would then be reported under a kind nobody wrote.
  if (!KINDS.includes(brief.kind)) {
    errors.push(`unknown \`kind: ${brief.kind}\` — must be one of ${KINDS.join(', ')}`);
    return { ok: false, errors, warnings, brief };
  }

  // A reference is never dispatched, so none of the brief rules apply to it — including the retired
  // sections, because a procedure aimed at a person is legitimately a procedure.
  if (brief.kind === 'reference') return { ok: true, errors, warnings, brief };

  if (!brief.goal) errors.push('no `## Goal` — a brief with no stated outcome is not a brief');
  if (brief.criteria.length < schema.MIN_CRITERIA) {
    errors.push(`only ${brief.criteria.length} criteria under \`## ${BRIEF_SECTION.criteria}\` (need ${schema.MIN_CRITERIA}) — with fewer, verification has nothing specific to grade and falls back to generic checks`);
  }

  for (const h of brief.retired) {
    errors.push(`\`## ${h}\` is the retired step-runner shape — its content must be converted, not left beside the brief, or a reader cannot tell which one governs`);
  }

  if (!brief.team.length) {
    errors.push('no `## Team` — without one the runner has no agent to dispatch to and falls back to a generic writer, which is the defect P3 exists to fix');
  }
  if (brief.team.length > MAX_TEAM) {
    errors.push(`team of ${brief.team.length} exceeds MAX_TEAM ${MAX_TEAM} — every member is a parallel model call on every run`);
  }
  const seen = new Set();
  for (const m of brief.team) {
    if (!m.name) { errors.push('a `## Team` bullet has no agent name'); continue; }
    if (seen.has(m.name)) errors.push(`\`${m.name}\` is listed twice — it would be dispatched twice and billed twice`);
    seen.add(m.name);
    // Slug first: on a case-insensitive filesystem the lookup below would PASS for `Reviewer` and
    // then fail on the Linux VPS. Checking the shape catches it on the machine that writes the file.
    if (!AGENT_SLUG.test(m.name)) {
      errors.push(`\`${m.name}\` is not a valid agent name — must be a lowercase slug matching the agent's filename, or it will not resolve on a case-sensitive filesystem`);
    } else if (known.size && !known.has(m.name)) {
      errors.push(`\`${m.name}\` is not a real agent — executeAgent fails hard on an unknown name, so every dispatch would return "Agent not found"`);
    }
    if (!m.why) warnings.push(`\`${m.name}\` is on the team with no stated reason — say what they own or drop them`);
  }

  if (!brief.hasGuardrailsSection) {
    warnings.push(`no \`## ${BRIEF_SECTION.guardrails}\` — an absent section is an omission; write "- None beyond each agent's own handbook." to record that the question was asked`);
  }
  if (!brief.outputs.length) warnings.push('no `## Output` — nothing states where the deliverable lands');

  for (const c of brief.criteria) {
    if (schema.looksProcedural(c)) {
      warnings.push(`criterion reads as a step, not a standard: "${c.length > 60 ? c.slice(0, 57) + '…' : c}"`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, brief };
}

/**
 * The task text handed to one team member.
 *
 * Carries the outcome, the criteria it will be GRADED against, the guardrails, the inputs and where
 * the deliverable goes — and nothing about how to proceed. The agent's own handbook is already its
 * system prompt, so its role, standards and gates arrive with it; repeating any of that here would
 * create a second, competing statement of the same thing.
 *
 * `role` is the one line from the team bullet saying what this member owns in THIS job. It is the
 * only per-member text, and it exists so a fan-out does not produce four copies of one answer.
 */
function buildTask(brief, { role = '', params = {}, skillName = '' } = {}) {
  const p = Object.keys(params || {}).length ? JSON.stringify(params) : '';
  return [
    `OUTCOME${skillName ? ` (${skillName})` : ''}: ${brief.goal}`,
    role ? `\nYOUR PART: ${role}` : '',
    p ? `\nINPUTS: ${p}` : '',
    brief.criteria.length ? `\nThe finished work will be graded against these, so treat them as the definition of done:\n${brief.criteria.map((c) => `- ${c}`).join('\n')}` : '',
    brief.guardrails.length ? `\nHARD LIMITS:\n${brief.guardrails.map((g) => `- ${g}`).join('\n')}` : '',
    brief.outputs.length ? `\nDELIVERABLE:\n${brief.outputs.map((o) => `- ${o}`).join('\n')}` : '',
    '\nDecide your own approach. Return the deliverable itself, not a plan for producing it.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  MAX_TEAM, BRIEF_SECTION,
  parseBrief, validateBrief, buildTask,
};
