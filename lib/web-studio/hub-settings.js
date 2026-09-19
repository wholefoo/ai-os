// lib/web-studio/hub-settings.js
// Per-site settings for the hub features: the newsletter block, whether ingested items publish
// immediately, and the Start-here page copy. Pure validation; the route persists and rebuilds.
//
// These are the OPERATOR's decisions, so the route that applies them is deliberately outside the
// `content` service-key scope — an ingest workflow can publish content, not change site policy
// (for example, it cannot switch on auto-publish to bypass drafts-by-default).
'use strict';

const LIMITS = { heading: 80, blurb: 300, button: 30, action: 500, startHereTitle: 80, startHereIntro: 300 };

function text(v, max, name, errors) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') { errors.push(name + ' must be a string'); return undefined; }
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > max) { errors.push(`${name} max ${max} characters`); return undefined; }
  return s;
}

/**
 * Merge a partial settings update onto the plan's current values.
 * @returns {{errors:string[]}|{settings:{newsletter:object, ingestAutoPublish:boolean, startHereTitle:string, startHereIntro:string}}}
 */
function normalizeHubSettings(input, plan) {
  const errors = [];
  const inp = input && typeof input === 'object' ? input : {};
  const cur = plan || {};
  const curN = cur.newsletter && typeof cur.newsletter === 'object' ? cur.newsletter : {};
  const newsletter = { enabled: curN.enabled === true, heading: curN.heading || '', blurb: curN.blurb || '', button: curN.button || '', action: curN.action || '' };

  if (inp.newsletter !== undefined) {
    const n = inp.newsletter;
    if (!n || typeof n !== 'object' || Array.isArray(n)) errors.push('newsletter must be an object');
    else {
      if (n.enabled !== undefined) {
        if (typeof n.enabled !== 'boolean') errors.push('newsletter.enabled must be boolean');
        else newsletter.enabled = n.enabled;
      }
      for (const k of ['heading', 'blurb', 'button']) {
        const v = text(n[k], LIMITS[k], 'newsletter.' + k, errors);
        if (v !== undefined) newsletter[k] = v;
      }
      if (n.action !== undefined) {
        const a = n.action === null ? '' : n.action;
        // https only: an http endpoint would send subscribers' addresses in the clear, and any other
        // scheme (javascript:, data:) in a form action is an injection vector.
        if (typeof a !== 'string') errors.push('newsletter.action must be a string');
        else if (a && (!/^https:\/\//i.test(a) || a.length > LIMITS.action || /\s/.test(a))) {
          errors.push('newsletter.action must be an https URL (or empty for the built-in signup)');
        } else newsletter.action = a;
      }
    }
  }

  let ingestAutoPublish = cur.ingestAutoPublish === true;
  if (inp.ingestAutoPublish !== undefined) {
    if (typeof inp.ingestAutoPublish !== 'boolean') errors.push('ingestAutoPublish must be boolean');
    else ingestAutoPublish = inp.ingestAutoPublish;
  }

  const startHereTitle = text(inp.startHereTitle, LIMITS.startHereTitle, 'startHereTitle', errors);
  const startHereIntro = text(inp.startHereIntro, LIMITS.startHereIntro, 'startHereIntro', errors);

  if (errors.length) return { errors };
  return {
    settings: {
      newsletter,
      ingestAutoPublish,
      startHereTitle: startHereTitle !== undefined ? startHereTitle : (cur.startHereTitle || ''),
      startHereIntro: startHereIntro !== undefined ? startHereIntro : (cur.startHereIntro || ''),
    },
  };
}

module.exports = { normalizeHubSettings };
