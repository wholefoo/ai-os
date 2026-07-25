// lib/business-clone/interview.js
// ============================================================
//  The interview that turns a business owner into a persona.
//
//  This is the product surface of the whole feature. A clone is only as good as what it knows
//  about its owner, and owners will not fill in a 40-field form — so this is a conversation that
//  walks the five persona dimensions, asks about what is actually still missing, and stops when
//  the persona is good enough to use rather than after a fixed number of questions.
//
//  Two model roles per turn, deliberately separated:
//    ASK      — produce the next question, given what's missing and what's already been said
//    EXTRACT  — turn the owner's free-text answer into a structured persona patch
//  They are separate because they fail differently. A bad ASK wastes a question. A bad EXTRACT
//  writes something false into the persona and every future draft inherits it. EXTRACT therefore
//  runs under much tighter instructions (see EXTRACT_RULES) and its output is merged additively —
//  extraction can never delete what the owner already told us (see mergePatch).
//
//  Pure module: builds prompt strings and merges parsed objects. It does not call a model and does
//  not parse JSON — server.js owns executeAgent and already owns a shared extractJson helper
//  (injected into commercial modules via ctx), so passing a parsed object in keeps this testable
//  without a provider key, matching persona.js and store.js.
//
//  INJECTION NOTE: persona fields are free text supplied by the owner, and they are compiled into
//  a system prompt. normalize() drops unknown keys and caps lengths, which bounds the blast radius,
//  but an owner CAN put instruction-shaped text into their own persona. That is accepted: it only
//  ever affects that owner's own clone, and the boundaries are re-checked against output by code
//  (persona.checkRedLines) rather than trusted to the prompt. Corpus material — which is NOT
//  first-party — is a different matter and is fenced as untrusted at the point of use in P2.
// ============================================================

'use strict';

const persona = require('./persona');

// Interview stops asking about a dimension once it reaches this. Not 100 on purpose — chasing the
// last few fields produces questions like "any other credentials?" that annoy owners and yield
// filler. The usability bar (persona.MIN_USABLE_COMPLETENESS) is what actually gates activation.
const DIMENSION_SATISFIED_AT = 80;

// Deterministic fallback questions, per dimension, keyed by the persona field they populate. Used
// verbatim when the ASK model call fails, and given to the ASK model as the intent to riff on so
// its adaptive questions stay anchored to fields that actually exist in the schema. Without this
// anchor a model happily asks lovely questions that map to no field and extract to nothing.
const SEED_QUESTIONS = {
  identity: {
    ownerName: 'What name should your clone use when it signs something — the name your customers know you by?',
    role: 'What is your actual role day to day, not your title on paper?',
    businessName: 'What is the business called?',
    industry: 'How would you describe your industry to someone outside it?',
    whatTheyDo: 'In your own words, what does your business actually do for people? Skip the marketing version — how would you explain it to a friend?',
    yearsExperience: 'How long have you been doing this?',
  },
  voice: {
    formality: 'When you write to a customer, are you closer to "Hi Dave —" or "Dear Mr. Whitfield"? Where on that line do you sit?',
    directness: 'When you have bad news for a client, do you lead with it or work up to it?',
    warmth: 'Do people describe you as warm, or as businesslike? Which would you rather they said?',
    humor: 'Do you use humour with customers? If so, what kind — dry, warm, playful, or none at all?',
    signaturePhrases: 'What are some phrases you catch yourself saying over and over? Even the ones you are slightly embarrassed by — those are the most useful.',
    avoidPhrases: 'What language makes you wince when you see it in your industry? Words or phrases you would never use.',
    signoff: 'How do you sign off an email?',
  },
  expertise: {
    domains: 'What are you genuinely expert in — the things people come to you for specifically?',
    methodologies: 'Do you have a particular method or process you work through? What is it called and what are the steps?',
    strongOpinions: 'Where do you disagree with the conventional wisdom in your field? What do most people in your industry get wrong?',
    faq: 'What are the three questions customers ask you most often, and how do you actually answer them? Answer them here the way you would say it out loud.',
    credentials: 'What qualifications, certifications, or track record should your clone be able to point to?',
  },
  decisionStyle: {
    priorities: 'When you are making a call and cannot have everything, what do you protect first? List them in order — the order matters more than the list.',
    tradeoffRules: 'Give me a real trade-off you make regularly: when X happens, you choose Y over Z.',
    riskPosture: 'Are you naturally cautious, balanced, or aggressive when there is money or reputation on the line?',
    escalationTriggers: 'What kinds of situations do you always want to handle personally, no matter how busy you are?',
  },
  boundaries: {
    neverSay: 'What must your clone never say? Specific words, claims, or promises that would be wrong or dangerous coming from you.',
    neverPromise: 'What must it never promise a customer — refunds, timelines, results, anything you cannot guarantee?',
    requiresHuman: 'What topics should always stop and come to you instead of being answered automatically?',
    pricingDisclosure: 'Can your clone discuss pricing? Not at all, ranges only, or full detail?',
  },
};

// ---- Role templates ---------------------------------------------------------
//
//  A template shapes the INTERVIEW, never the PERSONA. It changes which question gets asked and in
//  what order; it cannot write a field, and it cannot move the usability bar.
//
//  Both halves of that matter. Prefilling voice or expertise would make a clone assert things its
//  owner never said, presented as theirs — and the owner would then review drafts believing they
//  reflect them. Touching completeness would be the same mistake wearing different clothes:
//  completeness feeds persona.isUsable, which gates whether a clone may speak at all, so a template
//  with its own weights could lower the bar for a role. Templates get wording and order. Nothing else.
//
//  Only fields where the role genuinely changes the question are overridden; everything else falls
//  through to SEED_QUESTIONS, so a template is a diff rather than a fork.
const TEMPLATES = {
  owner: {
    label: 'Owner / Founder',
    description: 'Runs the business. Broad remit, final say on most things.',
    // Schema order suits an owner: everything reads better once the clone knows whose business it is.
    dimensionOrder: ['identity', 'voice', 'expertise', 'decisionStyle', 'boundaries'],
    questions: {},
  },

  sales: {
    label: 'Sales',
    description: 'Wins and manages customer relationships.',
    dimensionOrder: ['identity', 'voice', 'boundaries', 'expertise', 'decisionStyle'],
    questions: {
      expertise: {
        domains: 'What do you sell, and what do buyers most often misunderstand about it?',
        faq: 'What are the three objections you hear most, and what do you actually say back? Give me your real words, not the script.',
        strongOpinions: 'Where do you disagree with how your industry sells? What tactic do you refuse to use?',
      },
      decisionStyle: {
        tradeoffRules: 'Give me a real trade-off: when a deal is slipping, what do you concede and what do you hold?',
        priorities: 'When you cannot have everything on a deal, what do you protect first — margin, timeline, the relationship? In order.',
      },
      boundaries: {
        neverPromise: 'What must you never promise to close a deal — delivery dates, discounts, features that do not exist yet?',
        requiresHuman: 'Which deals or questions must always come to a person — pricing above a threshold, contract terms, anything else?',
        pricingDisclosure: 'How much can be said about price without you? Nothing, broad ranges, or full detail?',
      },
    },
  },

  support: {
    label: 'Customer Support',
    description: 'Resolves customer problems after the sale.',
    // Boundaries first after identity: a support clone is pointed at unhappy customers, and what it
    // must NOT say matters before how it sounds.
    dimensionOrder: ['identity', 'boundaries', 'voice', 'expertise', 'decisionStyle'],
    questions: {
      voice: {
        directness: 'When a customer is angry and partly wrong, do you lead with the correction or with the acknowledgement?',
        warmth: 'When someone is frustrated, do you match their urgency or deliberately stay calm?',
      },
      expertise: {
        domains: 'What problems do you fix most often?',
        faq: 'What are the three complaints you handle most, and how do you actually answer them? Word for word, the way you would say it.',
        methodologies: 'What is your process when something has gone wrong — what do you do first, second, third?',
      },
      decisionStyle: {
        tradeoffRules: 'When a customer wants something outside policy, when do you bend and when do you hold? Give me a real example.',
      },
      boundaries: {
        neverPromise: 'What can never be promised to calm someone down — refunds, replacements, timelines, compensation?',
        requiresHuman: 'What always comes to a person — refunds over an amount, legal threats, anything involving safety?',
      },
    },
  },

  operations: {
    label: 'Operations',
    description: 'Delivery, logistics, and keeping commitments.',
    dimensionOrder: ['identity', 'expertise', 'boundaries', 'decisionStyle', 'voice'],
    questions: {
      expertise: {
        domains: 'What parts of delivery are you responsible for?',
        methodologies: 'Walk me through how a job actually runs, start to finish.',
        faq: 'What do customers ask most about timing, delivery, or installation — and what do you tell them?',
      },
      decisionStyle: {
        tradeoffRules: 'When a schedule slips, what gives — cost, scope, or the date? Give me a real case.',
        priorities: 'When you cannot do everything today, what gets protected first? In order.',
        escalationTriggers: 'What kind of problem do you always raise rather than absorb quietly?',
      },
      boundaries: {
        neverPromise: 'What delivery or timing promise must never be made on your behalf?',
      },
    },
  },

  finance: {
    label: 'Finance / Admin',
    description: 'Invoicing, collections, and the money conversations.',
    dimensionOrder: ['identity', 'boundaries', 'decisionStyle', 'expertise', 'voice'],
    questions: {
      voice: {
        directness: 'When someone is late paying, how blunt do you get, and how quickly?',
      },
      expertise: {
        domains: 'What do you handle — invoicing, collections, payroll, reporting?',
        faq: 'What do customers ask most about billing, and how do you answer it?',
      },
      decisionStyle: {
        tradeoffRules: 'When do you extend terms and when do you hold the line? Give me a real case.',
      },
      boundaries: {
        neverSay: 'What must never be said in a money conversation, however justified it feels?',
        requiresHuman: 'What always comes to a person — write-offs, disputes, anything over an amount?',
        confidentialTopics: 'What financial detail must never leave the business — margins, costs, other customers\' terms?',
        pricingDisclosure: 'How much detail can be given on pricing and terms without you?',
      },
    },
  },

  marketing: {
    label: 'Marketing',
    description: 'Public voice — content, campaigns, and claims.',
    dimensionOrder: ['identity', 'voice', 'boundaries', 'expertise', 'decisionStyle'],
    questions: {
      voice: {
        signaturePhrases: 'What phrases show up again and again in your best-performing content? The ones that sound like you, not like everyone else.',
        avoidPhrases: 'What marketing language makes you cringe? The words you would cut on sight.',
      },
      expertise: {
        strongOpinions: 'What does your industry\'s marketing get wrong? Where do you go the other way?',
        domains: 'What are you actually trying to be known for?',
      },
      boundaries: {
        neverSay: 'What claim must never be made publicly, even if a competitor makes it? Anything that would be a legal or reputational problem.',
        neverPromise: 'What outcome must never be promised in public copy — results, timelines, guarantees?',
        confidentialTopics: 'What must never appear in public content — customer names, numbers, roadmap?',
      },
    },
  },
};

const DEFAULT_TEMPLATE = 'owner';

/** Ids of the available templates, for a picker. */
function templateIds() {
  return Object.keys(TEMPLATES);
}

/** Template metadata for a picker — no question banks, which are internal. */
function templateList() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description }));
}

/** Resolve a template id to its definition, falling back to the default rather than throwing. */
function getTemplate(id) {
  return TEMPLATES[String(id || '').trim()] || TEMPLATES[DEFAULT_TEMPLATE];
}

/** The dimension walk order for a template. Always a permutation of the real schema dimensions. */
function dimensionOrder(templateId) {
  const order = getTemplate(templateId).dimensionOrder || [];
  const valid = order.filter((d) => persona.DIMENSIONS.includes(d));
  // Anything the template omitted still gets asked — appended in schema order, never dropped.
  return [...valid, ...persona.DIMENSIONS.filter((d) => !valid.includes(d))];
}

/** Human-readable framing per dimension — used in the ASK prompt so questions land in context. */
const DIMENSION_INTENT = {
  identity: 'who this person is and what their business actually does',
  voice: 'how they sound in writing — rhythm, warmth, directness, the phrases that are unmistakably theirs',
  expertise: 'what they know that others do not, including where they disagree with their own industry',
  decisionStyle: 'how they make calls under pressure and what they protect when they cannot have everything',
  boundaries: 'the hard limits — what the clone must never say, promise, or handle without them',
};

/**
 * The dimension to work on next: the least-complete one that is not yet satisfied, walked in
 * schema order so ties resolve to identity-first (everything else reads better once the clone
 * knows who it is). Returns null when every dimension is satisfied.
 */
function nextDimension(personaObj, templateId) {
  const c = persona.completeness(personaObj);
  // The template sets the WALK ORDER, which decides ties. It does not change the scores, so a
  // template can front-load the dimensions that matter for a role without altering what "complete"
  // or "usable" mean.
  const order = dimensionOrder(templateId);
  let best = null;
  for (const dim of order) {
    const score = c.byDimension[dim].score;
    if (score >= DIMENSION_SATISFIED_AT) continue;
    if (!best || score < best.score) best = { dimension: dim, score, missing: c.byDimension[dim].missing };
  }
  return best;
}

/**
 * The questions for whatever is still missing in a dimension, in schema order.
 * A template's wording wins where it defines one; everything else falls through to the generic bank,
 * so a template is a diff and never has to restate the whole interview.
 */
function seedQuestions(dimension, missingFields, templateId) {
  const generic = SEED_QUESTIONS[dimension] || {};
  const roleBank = (getTemplate(templateId).questions || {})[dimension] || {};
  return (missingFields || [])
    .map((field) => {
      const question = roleBank[field] || generic[field];
      return question ? { field, question, fromTemplate: !!roleBank[field] } : null;
    })
    .filter(Boolean);
}

/** Compact transcript of recent turns, so the ASK model does not repeat itself. */
function recentTranscript(turns, limit = 8) {
  return (turns || [])
    .slice(-limit)
    .map((t) => `${t.role === 'owner' ? 'OWNER' : 'INTERVIEWER'}: ${t.text}`)
    .join('\n');
}

/**
 * Prompt for the ASK step. Returns { system, task, dimension, seeds } — the caller runs it through
 * executeAgent and falls back to `seeds[0].question` verbatim if the call fails, which is why the
 * seeds travel with the prompt rather than being looked up separately at the call site.
 */
function buildAskPrompt(clone) {
  const templateId = clone.templateId || DEFAULT_TEMPLATE;
  const target = nextDimension(clone.persona, templateId);
  if (!target) return null; // interview is done

  const seeds = seedQuestions(target.dimension, target.missing, templateId);
  const ownerName = clone.persona.identity.ownerName || 'the owner';

  const system = [
    'You are interviewing a business owner to build an AI clone of them — a system that will draft',
    'emails, replies, and content in their voice, which they will review before anything is sent.',
    '',
    'Interview well:',
    '- Ask ONE question at a time. Never send a numbered list of questions.',
    '- Be conversational and brief. Two sentences of setup at most.',
    '- Follow up on something specific they just said when it is worth pulling on. A concrete',
    '  follow-up gets far better material than moving to the next topic on a list.',
    '- Never ask for something they have already told you.',
    '- Ask for examples and actual wording, not self-description. "What do you say when a client',
    '  is late paying?" beats "How would you describe your tone?" — people describe themselves',
    '  inaccurately but quote themselves accurately.',
    '',
    'Output ONLY the question itself. No preamble, no explanation, no quotation marks.',
  ].join('\n');

  const task = [
    `You are currently exploring: ${DIMENSION_INTENT[target.dimension]}.`,
    '',
    `Still unknown about ${ownerName}: ${target.missing.join(', ') || '(nothing specific)'}`,
    '',
    'Questions that would fill those gaps (rewrite one to fit the conversation, or ask a better',
    'follow-up that targets the same gap):',
    ...seeds.map((s) => `- ${s.question}`),
    '',
    'Conversation so far:',
    recentTranscript(clone.interview.turns) || '(this is the first question)',
    '',
    'Ask the next question.',
  ].join('\n');

  return { system, task, dimension: target.dimension, seeds };
}

// The rules that keep EXTRACT from inventing a business. Stated as hard constraints because the
// failure mode is silent: a plausible invented FAQ answer looks exactly like a real one, and the
// owner will not notice it until their clone says it to a customer.
const EXTRACT_RULES = [
  'Extract ONLY what the owner explicitly stated. Never infer, embellish, or fill gaps.',
  'If they did not address a field, OMIT that field entirely. Do not guess and do not write "unknown".',
  'Preserve their actual wording for anything that will be spoken back in their voice —',
  'signaturePhrases, faq answers, and signoff must be their words, not a tidied-up paraphrase.',
  'If an answer is vague or evasive, extract nothing rather than extracting something weak.',
].join('\n');

// Per-dimension shape hints. Deliberately shows the nesting the merge expects, because a model
// given a flat field list will happily return a flat object that then merges into nothing.
const EXTRACT_SHAPES = {
  identity: `{ "identity": { "ownerName": "", "role": "", "businessName": "", "industry": "", "whatTheyDo": "", "yearsExperience": 0, "location": "" } }`,
  voice: `{ "voice": { "formality": 1-5, "directness": 1-5, "warmth": 1-5, "humor": "none|dry|warm|playful", "sentenceLength": "short|varied|long", "vocabulary": [], "signaturePhrases": [], "avoidPhrases": [], "greeting": "", "signoff": "" } }`,
  expertise: `{ "expertise": { "domains": [], "methodologies": [], "credentials": [], "strongOpinions": [{ "claim": "", "rationale": "" }], "faq": [{ "question": "", "answer": "" }] } }`,
  decisionStyle: `{ "decisionStyle": { "priorities": ["most important first"], "tradeoffRules": [{ "when": "", "prefer": "", "over": "" }], "riskPosture": "conservative|balanced|aggressive", "escalationTriggers": [] } }`,
  boundaries: `{ "boundaries": { "neverSay": [], "neverPromise": [], "requiresHuman": [], "pricingDisclosure": "none|ranges|full", "competitorPolicy": "", "confidentialTopics": [] } }`,
};

/**
 * Prompt for the EXTRACT step: owner's free-text answer -> partial persona object.
 *
 * The schema is described inline rather than passed as JSON Schema because the surrounding models
 * vary by tier here (this can land on Gemini or DeepSeek, not just Claude) and a prose contract
 * degrades more gracefully than a strict-schema request that some providers ignore outright.
 */
function buildExtractPrompt({ dimension, question, answer }) {
  const shape = EXTRACT_SHAPES[dimension] || '';

  const system = [
    'You convert an interview answer into structured JSON. You are a transcriber, not an author.',
    '',
    EXTRACT_RULES,
    '',
    'Respond with a single JSON object and nothing else.',
  ].join('\n');

  const task = [
    `Dimension: ${dimension}`,
    `Question asked: ${question}`,
    '',
    'Owner\'s answer:',
    '"""',
    String(answer || '').slice(0, 8000),
    '"""',
    '',
    `Return JSON of exactly this shape, omitting any field the answer did not address:`,
    shape,
  ].join('\n');

  return { system, task };
}

// ---- Merge ------------------------------------------------------------------

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Union two lists of strings, case-insensitively deduped, preserving existing order first.
 * Existing entries win on casing — the owner's original phrasing is the canonical one.
 */
function unionStrings(existing, incoming) {
  const out = [...existing];
  const seen = new Set(existing.map((s) => String(s).toLowerCase()));
  for (const item of incoming || []) {
    const s = String(item || '').trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** Union lists of objects, deduping on a key field. */
function unionObjects(existing, incoming, keyField) {
  const out = [...existing];
  const seen = new Set(existing.map((o) => String(o[keyField] || '').toLowerCase()));
  for (const item of incoming || []) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item[keyField] || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Object-list fields and the field they dedupe on.
const OBJECT_LIST_KEYS = {
  strongOpinions: 'claim',
  faq: 'question',
  tradeoffRules: 'when',
};

/**
 * Merge an extraction patch into a persona. ADDITIVE by design:
 *   - lists are unioned, never replaced — a later answer that mentions two phrases must not
 *     silently drop the five the owner gave earlier
 *   - scalars are overwritten only when the patch actually carries a value, so an omitted field
 *     (which EXTRACT is instructed to produce constantly) can never blank an answered one
 *
 * This is the single most important safety property of the interview: extraction runs many times
 * over a long conversation, and a replace-semantics merge would make every turn a chance to lose
 * everything said before it. Result is passed through persona.normalize, so caps and enum
 * validation apply to model output exactly as they do to hand-written input.
 */
/**
 * Merge one field. Returns the value to store — `current` unchanged whenever the incoming value is
 * absent, blank, or the wrong type, which is what makes every no-op case above a no-op.
 */
function mergeField(field, current, value) {
  if (Array.isArray(current)) {
    // A model returning a bare string where a list belongs must not corrupt the field.
    if (!Array.isArray(value)) return current;
    const objKey = OBJECT_LIST_KEYS[field];
    return objKey ? unionObjects(current, value, objKey) : unionStrings(current, value);
  }
  return isBlank(value) ? current : value;
}

function mergeDimension(baseDim, incomingDim) {
  if (!incomingDim || typeof incomingDim !== 'object') return baseDim;
  for (const [field, value] of Object.entries(incomingDim)) {
    if (!(field in baseDim)) continue; // unknown field — dropped, same policy as normalize
    baseDim[field] = mergeField(field, baseDim[field], value);
  }
  return baseDim;
}

function mergePatch(basePersona, patch) {
  const base = persona.normalize(basePersona);
  if (!patch || typeof patch !== 'object') return base;

  for (const dim of persona.DIMENSIONS) {
    base[dim] = mergeDimension(base[dim], patch[dim]);
  }

  return persona.normalize(base);
}

/**
 * Has the interview gathered enough? Deliberately the same bar as activation — an interview that
 * declares itself finished while the clone is still unusable is worse than one that keeps asking.
 */
function isComplete(personaObj, templateId) {
  return persona.isUsable(personaObj).usable && !nextDimension(personaObj, templateId);
}

/** Progress payload for the interview UI. */
function progress(personaObj, templateId) {
  const c = persona.completeness(personaObj);
  const target = nextDimension(personaObj, templateId);
  return {
    overall: c.overall,
    byDimension: c.byDimension,
    currentDimension: target ? target.dimension : null,
    complete: isComplete(personaObj, templateId),
    usable: persona.isUsable(personaObj).usable,
  };
}

module.exports = {
  DIMENSION_SATISFIED_AT,
  SEED_QUESTIONS,
  TEMPLATES,
  DEFAULT_TEMPLATE,
  templateIds,
  templateList,
  getTemplate,
  dimensionOrder,
  nextDimension,
  seedQuestions,
  buildAskPrompt,
  buildExtractPrompt,
  mergePatch,
  isComplete,
  progress,
};
