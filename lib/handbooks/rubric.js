// lib/handbooks/rubric.js — turn a handbook's criteria into verification checks.
//
// P2 of .magent/vault/wiki/agent-handbooks-design.md.
//
// Before this, verification graded output against `.claude/rules/verification-rubrics.yaml` keyed by
// SKILL CATEGORY — six generic buckets (default, research, marketing, security, sales, design)
// resolved from a skill file's frontmatter. Two problems with that, and P3 makes the second fatal:
//
//   1. The bar was generic. "Actionability: output contains clear next steps" is true of everything
//      and specific to nothing, so a pass tells you almost nothing about whether THIS agent did ITS
//      job. Meanwhile every agent now carries criteria that say exactly what its job is.
//   2. The key came from a SKILL. P3 retires the step-runner and with it the skill-as-execution-unit,
//      so a rubric keyed on skill category would lose its key entirely.
//
// So checks now come from the agent's own `## What good looks like`, with the named rubric kept
// underneath as a floor. The chain is: default rubric → the rubric the handbook names → the
// handbook's own criteria.
//
// A NOTE ON THE DESIGN DOC'S WORDING: §7 called that middle level "department". It is implemented as
// the `rubric:` key the handbook declares, which is usually but not always the department (every
// SEO agent declares `marketing`; `sysadmin` declares `security`). Naming it after the declaration
// rather than the org chart keeps one source of truth — a handbook says which floor it answers to.
//
// Pure: shapes and merging. No I/O, no model calls.

'use strict';

const crypto = require('crypto');
const schema = require('./schema');

/**
 * Weight for a criterion drawn from a handbook.
 *
 * 3 is the top band already in use by the YAML rubrics, and handbook criteria earn it: they are
 * specific to this agent and every one traces to a real failure, where a generic check like
 * "formatting" (weight 2) applies to anything. If agent-specific standards did not outweigh generic
 * ones, an output could fail the thing that actually matters and still pass on volume.
 */
const HANDBOOK_WEIGHT = 3;

/** Ceiling on how many criteria become checks. Each check is a separate grading model call. */
const MAX_HANDBOOK_CHECKS = 12;

/**
 * A stable id for a criterion, derived from its text.
 *
 * Stable across runs so the same criterion can be TRACKED over time — which is the whole point of
 * §9 item 14: criteria and Gotchas overlap in many handbooks, nobody knows which formulation a model
 * acts on, and the way to settle it is to see which criteria ever actually fail and delete the ones
 * that never do. That needs an id that survives between runs.
 *
 * Deliberately derived from the TEXT, not from position: reordering a list must not renumber every
 * criterion, and editing one SHOULD give it a new id, because an edited criterion is a different
 * claim and its old history no longer applies to it.
 */
function criterionId(text) {
  return 'hb-' + crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

/** A short label for the UI — the criterion's first clause, which is where its subject lives. */
function shortLabel(text) {
  const s = String(text || '').trim();
  const cut = s.search(/[.—:;]/);
  const head = (cut > 12 ? s.slice(0, cut) : s).trim();
  return head.length > 72 ? head.slice(0, 69).trimEnd() + '…' : head;
}

/**
 * Checks derived from one handbook's `## What good looks like`.
 *
 * @param {string} content  raw agent .md
 * @returns {Array<{id,name,description,weight,category,source}>}
 */
function checksFromHandbook(content) {
  const { body } = schema.split(content);
  const criteria = schema.sectionBullets(body, schema.SECTION.criteria);
  return criteria.slice(0, MAX_HANDBOOK_CHECKS).map((text) => ({
    id: criterionId(text),
    name: shortLabel(text),
    description: text,
    weight: HANDBOOK_WEIGHT,
    category: 'handbook',
    source: 'handbook',
  }));
}

/**
 * Merge handbook checks over a floor rubric.
 *
 * Handbook checks come FIRST so a grader reading the list in order meets the specific standards
 * before the generic ones, and so a truncated display shows what matters.
 *
 * Deduplication is by id, and the floor's checks are the ones dropped on collision — a handbook that
 * restates a generic check has said it more specifically, and grading the same thing twice would
 * double its weight in the aggregate without anyone choosing that.
 */
function mergeRubric(handbookChecks, floorRubric, meta = {}) {
  const floor = (floorRubric && Array.isArray(floorRubric.checks)) ? floorRubric.checks : [];
  const seen = new Set(handbookChecks.map((c) => c.id));
  const kept = floor
    .filter((c) => !seen.has(c.id))
    .map((c) => ({ ...c, source: c.source || 'rubric' }));

  return {
    name: meta.agent ? `${meta.agent} handbook` : (floorRubric && floorRubric.name) || 'Handbook',
    description: meta.agent
      ? `${meta.agent}'s own standards, over the ${(floorRubric && floorRubric.category) || 'default'} floor`
      : (floorRubric && floorRubric.description) || '',
    category: (floorRubric && floorRubric.category) || 'default',
    agent: meta.agent || null,
    checks: [...handbookChecks, ...kept],
    handbookCheckCount: handbookChecks.length,
    floorCheckCount: kept.length,
  };
}

/**
 * Which floor rubric a handbook answers to — its `rubric:` frontmatter, or 'default'.
 *
 * Returns a NAME, not a rubric: this module does no I/O, and the caller owns the YAML.
 */
function floorNameFor(content) {
  const meta = schema.parseFrontmatter(schema.split(content).frontmatter);
  return meta.rubric || 'default';
}

module.exports = {
  HANDBOOK_WEIGHT, MAX_HANDBOOK_CHECKS,
  criterionId, shortLabel, checksFromHandbook, mergeRubric, floorNameFor,
};
