# Knowledge & Records (Department #11) — Architecture & Delivery Plan

*Status: **PHASE 0 IS BUILT, TESTED, AND COMMITTED.** Rev 3 was approved by Reviewer; rev 4 added the CI release procedure; rev 5 (this revision) records what construction changed. P1 onward remain unbuilt design.*

*Commits on `feature/library-department` (not pushed): `90225d7` library core · `85e423e` canon sweep + CI release procedure · and in the commercial repo, `6bfa62a` its initial commit (that repo had **zero** commits before — every file was untracked and unrecoverable).*

*P0 gates, all green: `tools/test-all.js` 34/34 · canon `git grep` returns nothing · `check-copy-drift.js` 22/22 on all three surfaces · `library-migrate.js` idempotent (second run adds 0, skips 11) · live routes return 16 records / 5 facts to an operator and fail closed for an unnamed person.*

*Revision 5 — **what building it changed.** Six amendments, every one found by RUNNING the code rather than reading it, which is the honest headline: three review passes over the prose found none of them. Summarised here, detailed in §9 items 13-18.*
1. *A `value` field was added to the record — the first implementation put a canonical fact's payload in its first TAG, so correctness depended on the order of an unordered set.*
2. *An `all-operators` sentinel and an `operator` requester kind were added, because §4's `readers:['all-agents']` vault default claimed to preserve today's behaviour but would have shown **every human an empty vault**.*
3. *Canonical facts needed a distinct dedupe identity; seeded with empty `path`/`contentHash` they collapsed to one record on the first migrate, and **the shelf built to end silent drift silently destroyed four fifths of itself**.*
4. *`..` is now refused as a path segment in every store — `basename` does not escape, but it silently REWRITES to a different real file.*
5. *A new file, `lib/library/paths.js`, was extracted for the path guard, because a security boundary that can only be exercised by booting the server is one nobody verifies.*
6. *The canonical-facts seed must run AFTER `ORG_CHART` is built — a temporal-dead-zone crash that `node --check` cannot see.*

*Also: the sweep found **four canon sites in `server.js` that §6 P0 item 7's table did not know about**, including a second, live, user-facing Atlas system prompt. See §9 item 18.*

*Revision 4 — the release-procedure gap, found after approval while checking the Reviewer's O2 (README carries a stale count). O2 turned out to be the visible edge of something larger: `tools/check-copy-drift.js` is a **CI-gated** drift check (`.github/workflows/ci.yml:51`), and `.claude/commands/ship.md:10` documents the required procedure for any public-surface feature — update `README.md`, the landing `featureList` JSON-LD in `dashboard/index.html`, **and** the `FEATURES` manifest in the drift check, in the same commit. A new department is unambiguously a public-surface feature. As approved, P0 named none of those four surfaces — which produces the *silent* form of the failure (CI stays green while the public copy quietly omits a whole department), with the loud form arriving only if someone adds the manifest entry without the copy. `DOCS_ENFORCE = true` additionally requires the feature to be documented somewhere in `dashboard/docs/*.html`. Now specified as P0 item 8. Two further canon sites also surfaced and are included: the Atlas voice-agent system prompt (`agent-worker/agent.js:27`, which speaks the count aloud to users) and the published A2A agent card (`lib/a2a.js:31`).*

*Revision 3 — Reviewer sign-off round; verdict was REVISE with three blocking issues, all fixed here. (B1) the P0 verify gate tested only the department string while the DoD forbids the agent counts too, so a page asserting "66 agents" passed a green check — the gate now matches the DoD. (B2) the dashboard manifest glob `**/*.html` excluded `dashboard/js/app.js` and `dashboard/llms.txt`, which both carry the counts. (B3) the artifacts store is a nested tree, so the flat basename guard the schema claimed to inherit cannot express a valid artifact path — the read rule is now stated per store. Two corrections to the review itself: the department-string count is **27** files, not 25 (auto-research carries 6 hits, not 4) — though the sweep the Coder actually performs is **25 tracked files** across all phrasings, which is a different 25 than the review's. And a fourth issue the review did not catch: **3 of the 6 auto-research hits are gitignored regenerated artifacts**, so the verify gate as originally written could never go green — it is now scoped to tracked files. Non-blocking N1/N3/N4 also applied; N2 and N5 accepted as-is with reasons in §9.*

*Revision 2 — orchestrator review applied. Four corrections against the code: (1) the legacy vault reads are session-authenticated, not public, so the back-compat recommendation no longer proposes a public surface (D-VAULTAUTH, §9.5); (2) Phase 2 now handles the `CLIENT_API_ALLOW` deny-by-default client guard, without which the contribute route 403s for the personnel it exists for; (3) Phase 0 now carries the product-canon sweep, because creating department #11 invalidates the hard-coded "10 departments / 66 agents" in 27 files; (4) route tables name the middlewares that actually exist (`requireAdmin`, `requireClientOrAdmin`, global `authMiddleware`) — there is no `requireAuth` in this codebase.*

Locked decisions: department id `library`, name "Knowledge & Records", #11 · **community** placement · four seats (Chief Librarian NEW, `archivist` NEW, `knowledge-graph` RELOCATED, `golden-loop` RELOCATED) · catalog-over-stores (no fourth physical store) · untrusted-by-default with **no trusted tier** · `readers` allowlist from day one · delete/dispose through the Auto-Mode gate · Ed25519 provenance on outward publish · PDF ingest specced as real work.

---

## 1. Executive Summary

A **Knowledge & Records department** that takes ownership of the company's scattered document machinery and turns it into one governed library. Today four partial implementations each own a slice — the Memory Vault (`.magent/vault`), the document-extraction pipeline (`lib/org/documents.js` → `.magent/org-docs`, currently empty), the artifacts tree (`.magent/artifacts`), and two department-less agents (`knowledge-graph`, `golden-loop`). None of them knows who owns a document, who may read it, how sensitive it is, or when it should be disposed of. The library does not build a fifth thing. It is a **catalog** — a single index over the three existing physical stores — plus a **read choke-point** through which every agent, on every tier, reads library content *as fenced untrusted data*. New uploads land in exactly one existing store (`org-docs`, via the extraction module the archivist extends rather than forks); nothing is physically moved.

The single most important property, stated up front because the rest of the design is subordinate to it: **the library has no trusted tier.** Its whole purpose is that every agent reads it, and much of its content will be documents nobody on our side authored. Every byte leaves the library through `executeAgent`'s fencing envelope as *data*. There is no "it came from inside, therefore it is safe" path, because a library that every agent reads is, by construction, the highest-value prompt-injection surface in the product — larger than the clone feature, which fences for exactly this reason at a fraction of the blast radius.

The department also delivers a structural fix for a documented, recurring defect: product facts (agent count, model count, pricing, limits) live today in several hard-coded copies that drift apart. A **canonical-facts shelf** in the catalog makes those facts a single governed record every caller reads, so "update the number" stops meaning "find and edit N copies."

**Strategic frame (billionaire-strategist lens, kept honest):**
- **Problem-first.** The burning pain is not "we lack a library product." It is (a) knowledge entropy — facts scattered across three stores with no owner, no sensitivity, no retention, so nobody can answer *what do we know, who can see it, when does it go*; and (b) the stale-number tax, where copies of the same fact drift and ship wrong. Both are felt daily by the operator and by every agent that answers from stale context.
- **Scale lever: CODE + IP.** A read choke-point every agent uses 24/7 (code that works without permission) sitting over the company's accumulated knowledge (IP that compounds). It decouples "answer correctly" from "someone remembering to update copy N."
- **Common enemy: drift.** Stale, unfindable, ungoverned documents — the daily tax the department is framed against.
- **Beg and borrow before building.** The entire department is assembled from four existing partial implementations. Borrowing the forest, not planting one.

---

## 2. Architecture Overview

Four layers. The load-bearing invariant lives at the boundary between the catalog and any agent: content only ever crosses it inside the untrusted fence.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  DASHBOARD (existing Memory Vault view, extended)                          │
│  Library: browse · search · record detail · upload · contribute · retention│
└───────────────┬──────────────────────────────────────────────────────────┘
                │ REST  /api/library/*   (+ back-compat /api/vault/*)
┌───────────────▼──────────────────────────────────────────────────────────┐
│  CATALOG (server.js state 'library_catalog'  +  lib/library/*)             │
│   catalog.js  — record shape, normalize, dedupe-by-hash, search predicates │
│   readers.js  — ALLOWLIST access model (mirrors lib/org/visibility.js)     │
│   intake.js   — wraps lib/org/documents.js (does NOT reimplement extract)  │
│   contribute.js — clone/personnel contributions, persona-leak tripwire     │
│   ── the READ CHOKE-POINT: libraryLookup() → returns fenced untrusted[] ── │
└───────┬───────────────────────────┬───────────────────────┬───────────────┘
        │ executeAgent(untrusted:…)  │ gateAction(delete/dispose)             │ signProvenance()
┌───────▼───────────────────┐  ┌────▼──────────────────┐  ┌─▼───────────────────────┐
│  AGENT TEAM (.claude)      │  │  AUTO-MODE GATE        │  │  PROVENANCE              │
│  chief-librarian (head)    │  │  lib/safety/approval.js│  │  lib/provenance Ed25519  │
│  archivist                 │  │  library.delete-record │  │  sign on outward publish │
│  knowledge-graph (moved)   │  │  library.retention-…   │  │  (signProvenance @1530)  │
│  golden-loop     (moved)   │  └────────────────────────┘  └──────────────────────────┘
└───────┬────────────────────┘
        │ index over (nothing moves)
┌───────▼──────────────────────────────────────────────────────────────────┐
│  PHYSICAL STORES (unchanged — the catalog indexes them in place)           │
│  1. Memory Vault  .magent/vault/{raw,wiki,outputs}   (markdown, community) │
│  2. org-docs      .magent/org-docs/<uuid>.txt        (extracted text)      │
│     ── the ONE canonical landing zone for new uploads (currently empty) ── │
│  3. artifacts     .magent/artifacts/{docs,…}         (agent output)        │
│  catalog index    .magent/library/catalog.json  = metadata, NOT a store    │
└────────────────────────────────────────────────────────────────────────────┘
```

**How they fit:**
- **The catalog is an index, not a store.** `.magent/library/catalog.json` holds metadata only (record schema in §4). Document *bytes* never live there. This is why it is not the "fourth store" the brief forbids — no document content moves.
- **One landing zone for new content.** New uploads go through `lib/org/documents.js` and land in `.magent/org-docs/` under a generated uuid, exactly as the clone feature's uploads do. The clone company-profile flow becomes *one consumer* of that store rather than its sole owner. No new physical store, no second extractor.
- **One read choke-point.** `libraryLookup(query, {requester})` is the *only* way library content reaches an agent. It resolves reader-permitted records, reads their bytes, and returns them shaped as `untrusted` blocks for `executeAgent`. Callers pass that array to `executeAgent(..., { untrusted })` and **never** concatenate record content into a task string or `systemOverride`. There is no second read path.
- **The physical stores keep their own guards.** The catalog does not relax any existing guard; it inherits every one (path handling, format allowlist, zip-bomb ceilings, org scoping — see §7 Security boundaries).

---

## 3. The Knowledge & Records agent team

New **community** department `library` added to `COMMUNITY_ORG_CHART` (server.js ~8440). Four seats: two net-new agents, two relocated. See §6 Phase 0 for the exact org-chart and `team.yaml` edits, and §8 (D-COMM) for the community-vs-commercial justification.

| Agent | New? | Org entry | Tier / Effort | One-line role |
|---|---|---|---|---|
| **chief-librarian** | NEW | `lib-chief` "Athena" 📚, reportsTo `ceo` | strategic / xhigh | Department head: taxonomy authority, cross-department lookup, routing, retention *decisions* (legal hold is a consult, not its call). Reads only — never ingests. |
| **archivist** | NEW | `lib-archivist` "Vellum", reportsTo `lib-chief` | professional / high | Intake, format handling, dedupe, metadata, versioning. **Extends** `lib/org/documents.js`; does not reimplement extraction. |
| **knowledge-graph** | RELOCATED | `lib-graph` "Archive", reportsTo `lib-chief` | professional / high | Categorization, connection discovery, `.magent/knowledge-graph.json`. Unchanged behavior; new home. |
| **golden-loop** | RELOCATED | `lib-loop` "Tether", reportsTo `lib-chief` | professional / high | Source-change detection + NotebookLM/Gem re-sync. Unchanged behavior; new home. |

**No retention/records officer seat.** Retention and legal hold *consult* the existing `compliance-officer` (Shield, Legal dept) and `general-counsel` (Justice, Legal dept). The Chief Librarian owns the retention *decision*; a record under legal hold cannot be disposed of until Legal clears it (enforced as a `legalHold` flag that the delete/dispose executors refuse — §6 Phase 3).

**Divergence flagged (see §8, D-KG):** `knowledge-graph` is *not* currently department-less — it is placed in the **commercial** `product` department as `prod-knowledge` ("Archive"). Relocation therefore means **removing** it from `ai-os-commercial/org-chart/departments.js` *and* adding it here, not merely adding it. `golden-loop` *is* genuinely department-less (present in `team.yaml` and as an agent file, absent from every org chart), so it is a pure add.

---

## 4. The catalog record schema

The record is the whole design in one shape. Interface signature only (spec, not code):

```ts
// .magent/library/catalog.json  →  loadState/saveState('library_catalog', LibraryRecord[])
interface LibraryRecord {
  id:          string;          // uuid — OURS, never derived from any user string (path-traversal defence)
  title:       string;          // label only, ≤200 chars, NEVER used as a path
  store:       'vault' | 'org-docs' | 'artifacts';   // which physical store holds the bytes
  path:        string;          // location WITHIN that store. The read guard is PER STORE — see below;
                               // there is no single rule, because the stores are not the same shape
  contentHash: string;          // sha256 hex of the bytes (provenance.sha256Hex) — the dedupe + version key
  format:      string;          // txt|md|csv|docx|xlsx|pdf  (documents.extensionOf — the SAME allowlist)
  bytes:       number;

  source:      'company-doc' | 'clone-contribution' | 'personnel-contribution'
             | 'agent-output' | 'canonical-fact';
  owner:       string;          // orgKey (email) — orgMembership.orgKeyFor / sessionOrgKey
  addedBy:     string;          // email of the person, or the agent name, that added it
  addedAt:     string;          // ISO

  // ACCESS — the load-bearing field. An ALLOWLIST, built entry-by-entry (mirrors lib/org/visibility.js).
  // Entries are: an org email (a person), an agent name, or one of TWO sentinels — 'all-agents' and
  // 'all-operators'. NEVER a denylist.
  //
  // AMENDED IN REV 5. This originally said "the sentinel 'all-agents'" (singular) and gave migrated
  // vault content `readers:['all-agents']`, described as preserving today's behaviour. It does not:
  // the legacy vault is readable by any authenticated OPERATOR, and 'all-agents' admits agents only,
  // so every human would have seen an empty vault. The two sentinels stay separate rather than
  // merging into one broad grant because an agent read is wrapped in the untrusted fence and a human
  // read is not — one sentinel for both would silently make every grant to a bot a grant to a person.
  // Migrated vault + artifacts content is therefore ['all-agents','all-operators'].
  readers:     string[];
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';   // human-facing label; `readers` enforces

  retention:   { policy: 'keep' | 'review' | 'expire';
                 reviewAt: string | null; disposeAt: string | null };   // defaults P0 = {policy:'keep'}
  legalHold:   boolean;         // set ONLY via the Legal consult route; blocks delete/dispose executors

  provenanceId: string | null;  // set when published outward + Ed25519-signed (§6 Phase 3)
  personaDerived: false;        // an INVARIANT: must always be false. A true value is a defect the
                                // contribution path refuses (findLeaks tripwire — §6 Phase 2)
  tags:        string[];

  // ADDED IN REV 5. A canonical fact's payload; null on every document record, where the bytes are
  // the content. The first implementation had no such field and read the record's FIRST TAG instead —
  // so `tags:['counts','68']` answered "counts", and any future code that sorted or de-duplicated tags
  // would have broken every fact on the shelf without a word. A shelf whose entire purpose is to end
  // silent numeric drift must not itself be able to fail silently. Stored as a string so every caller
  // quotes it identically.
  value:       string | null;
}
```

**Canonical facts need a real identity (rev 5).** A fact has no bytes, so the first seed gave every one
of them `path:''` and `contentHash:''` — which made all five share the dedupe key `vault::::`, and the
first `library-migrate` run collapsed the shelf to a single record and destroyed the other four.
Silently. Facts now carry a synthetic `path` (`canonical/<title-slug>`) and a `contentHash` of the
value, which also makes the version anchor work for facts exactly as it does for documents: change the
value, change the hash. `tools/test-library-catalog.js` asserts both halves — that distinct facts
survive dedupe, and that records sharing an empty identity *do* collapse, documenting the trap.

**Facts derive their values; they are not typed in.** The seed counts the live agent registry and org
chart at boot (11 departments, 68 agents, 19 community). A shelf that must be hand-updated is a
hard-coded copy with better manners.

**The `path` read guard, per store — specified because one rule does not fit all three.** P0 catalogs all three stores and `libraryLookup` reads their bytes, so an implementer hits this in Phase 0. Do not generalize the vault's guard across stores:

| `store` | Shape | Read rule |
|---|---|---|
| `vault` | **Flat** — `vault/{raw,wiki,outputs}/<file>` | `path.basename` + confirm `path.dirname(resolved) === dir`, exactly as the existing vault routes do (server.js ~5697). Valid *only* because the folder is flat. |
| `org-docs` | Flat, uuid-named | Id-only via `orgDocTextPath()` — the filename is never user-derived, so there is nothing to sanitize. Strongest of the three; prefer it for new content. |
| `artifacts` | **Nested tree** — `artifacts/{docs,code,media,research,web-studio,youtube}/…` | `basename` **cannot express a valid path here** and must not be used. Resolve `path.join(ARTIFACTS_DIR, record.path)`, then assert containment: `path.relative(ARTIFACTS_DIR, resolved)` must not be empty, must not start with `..`, and must not be absolute. |

The containment assertion is the general form; the vault's basename check is a special case of it that happens to be sufficient for a flat directory. If in doubt on any future store, use containment — it is correct for both shapes.

**Rev 5 — two changes construction forced here:**

- **`..` is refused as a path segment in EVERY store, before any store-specific rule runs.** The table above is not sufficient on its own. `basename` does not let a path escape the vault — but it silently *rewrites*: `wiki/../../../../etc/passwd` flattens to `<vault>/wiki/passwd`, a real file the record does not name. A guard that quietly resolves to something else is worse than one that refuses, because no caller can tell it happened. No legitimate record path contains `..` (they are generated from real directory entries), so refusing costs nothing and removes a whole class of reasoning. Separators are normalised first, so a Windows-style `wiki\..\..\x` cannot slip past a `/` split.
- **The guard lives in its own module, `lib/library/paths.js`, taking its store roots as an argument.** It was written inline in `server.js`, where the only way to exercise it was to craft a hostile catalog record and restart the server. It is the library's path-traversal boundary, and **a boundary that cannot be unit-tested is a boundary nobody verifies** — the two `basename`-rewrite bugs above were found by the extracted module's first test run, not by review. `tools/test-library-paths.js` is written as attacks rather than happy paths.

**Field notes worth their own line:**
- `readers` is the enforcement; `sensitivity` is advisory. The reader-filter answers one question: *is the requester in `readers`, or is `'all-agents'` present and the requester an agent?* Built by allowlist so that adding a new field to the record can never accidentally widen access — the exact failure `visibility.js` was written to prevent.
- `contentHash` is both the dedupe key (same bytes already cataloged ⇒ don't double-store) and the version anchor (same `store`+logical title, new hash ⇒ a new version pointing at its predecessor via `tags`/a `supersedes` note).
- `personaDerived` exists as a named, always-false invariant so the test suite can assert it over whole responses (the `findLeaks` pattern), not field-by-field.

---

## 5. Machinery the department takes ownership of (reuse, don't rebuild)

Every row is an existing, verified anchor. Nothing here is net-new machinery.

| Existing machinery | Verified location | How the library uses it |
|---|---|---|
| Document extraction | `lib/org/documents.js` — `SUPPORTED=['txt','md','csv','docx','xlsx']`, `MAX_UPLOAD_BYTES` 10MB, `MAX_TEXT_CHARS` 400k, `readZipEntry` (bomb guard) | `archivist` intake **wraps** `extract()`. PDF is added *inside this module* (§6 P3) so one allowlist + one set of guards stays authoritative. |
| Extracted-text store | `.magent/org-docs/` + `orgDocTextPath()` (id-only path) — server.js ~11049 | The ONE landing zone for new uploads. Currently empty; the library populates it. |
| Untrusted fencing | `lib/safety/untrusted.js` `fenceUntrusted`; `executeAgent(..., {untrusted})` server.js ~3569/3610 | The read choke-point returns `untrusted[]` and callers pass it here. The whole no-trusted-tier guarantee. |
| Reader access model | `lib/org/visibility.js` — allowlist builders, `FORBIDDEN_KEYS`, `findLeaks` | `readers` allowlist + the persona-leak tripwire on contributions. |
| Org scoping | `lib/org/membership.js` `orgKeyFor`/`orgKeyForSession`; `sessionOrgKey` server.js ~10906 | `owner`/`readers` keyed to the org, so multi-tenant scoping is free. |
| Auto-Mode gate | `lib/safety/approval.js` `decide()`; `gateAction`/`ACTION_EXECUTORS`/`ALWAYS_GATE` server.js ~2694/2845/8629 | Delete + retention-dispose registered as `'critical'` actions (§6 P3). |
| Provenance | `lib/provenance/index.js` `sign/verify`; `signProvenance` server.js ~1530 | Ed25519 sidecar on any record published outward. |
| Vault read surface | server.js ~4393 (`getVaultStats`/`searchVault`/`getSessionContext`) + routes ~5651 | Back-compat `/api/vault/*` kept working, re-pointed to read through the catalog. |
| State + tests | `loadState/saveState`; `tools/test-*.js` auto-discovered by `tools/test-all.js` | `library_catalog` state; new `tools/test-library-*.js` suites picked up automatically. |

---

## 6. Phased build plan

Phase gates are the same shape as the Web Studio plan: In scope · Deferred · Definition of done · Verify.

### Phase 0 — Catalog + read path + migration (MVP) — ✅ BUILT (`90225d7`, `85e423e`)

*Everything below is what was specified. What was actually built differs in six ways, all recorded in the rev-5 note at the top and §9 items 13-18. Where the two disagree, the code is right and this section is history.*

**Files that shipped but are not in the manifest below:** `lib/library/paths.js` (the path guard, extracted to be testable) and `tools/test-library-paths.js`.

**The read choke-point's return shape, stated precisely because the prose was ambiguous:** `libraryLookup()` returns `untrusted: [{label, text}]` — the array shape `executeAgent`'s `untrusted` option takes — **not** pre-fenced text. `fenceUntrusted()` mints a fresh random nonce per call, so fencing belongs inside `executeAgent` where the nonce belongs to that one prompt. Pre-fencing in the lookup would reuse a single nonce across every caller and hand an attacker the exact markers needed to forge a fence. §2's "returns fenced untrusted[] blocks" should be read this way.

**Goal:** *every existing document across all three stores is cataloged with owner/sensitivity/readers/retention, and every agent can read library content through one fenced choke-point — with the canonical-facts shelf live so the stale-number defect has its structural fix.*

**In scope:**
1. **Catalog core.** `lib/library/catalog.js` (NEW, pure — no I/O): record `normalize()`, `dedupeByHash()`, `search()`/`filter()` predicates, canonical-facts helpers. `lib/library/readers.js` (NEW, pure): `buildReaders()` (allowlist, entry-by-entry), `canRead(record, requester)`, and a `findLeaks`-style whole-record tripwire re-exported from `visibility.js`.
2. **State + routes** in server.js (MODIFIED): `library_catalog` via `loadState/saveState`; the read choke-point `libraryLookup(query,{requester,limit}) -> { records, untrusted[] }`.
3. **Migration** `tools/library-migrate.js` (NEW, idempotent): backfill catalog records for `.magent/vault/wiki/*.md`, existing `org-docs`, and `.magent/artifacts/**` **in place** (nothing moves). Dedupe by `store`+`path`+`contentHash`. Defaults: vault → `sensitivity:'internal'`, `readers:['all-agents']`, `retention:{policy:'keep'}`; artifacts → `source:'agent-output'`, lighter metadata. Supports `--dry-run`.
4. **Canonical-facts shelf.** Seed a small set of `source:'canonical-fact'` records (agent count, model/tier count, pricing, limits) with `sensitivity:'internal'`, `readers:['all-agents']`. This is the shelf callers read instead of hard-coding numbers.
5. **Org chart + roster.** Add the `library` department to `COMMUNITY_ORG_CHART`; remove `prod-knowledge` from the commercial chart; add the two new agents to `EFFORT_ROUTING` and `team.yaml`; add/relocate the four agent files.
6. **Back-compat.** `/api/vault/*` keep working, re-pointed through the catalog, at their existing session-auth level plus reader filtering (D-VAULTAUTH).
7. **Product-canon sweep — not optional, and not a follow-up.** Creating department #11 invalidates every hard-coded department and agent count in the product copy. The counts move to **11 departments**, **68** licensed agents, **19** community placed agents. Verified scope:

   | What | Count | Notes |
   |---|---|---|
   | `10 departments` under `dashboard/` | 21 files | Includes `dashboard/js/app.js` and `dashboard/llms.txt` — **not** just `.html` |
   | `10 departments` under `auto-research/` | 6 files, **3 tracked** | Tracked: `seed/landing-seo.html`, `instructions.md`, `score.js`. Gitignored generated artifacts (do not edit): `asset/`, `history/best/`, `history/iter-001-kept/` |
   | **The actual sweep scope** — all phrasings, tracked only | **25 files** (22 dashboard + 3 auto-research) | This is what the verify gate returns and what the Coder edits |
   | Same union counting gitignored copies | 28 files | Stated only to explain the discrepancy — the extra 3 regenerate |

   Phrasings in use, all of which the gate must match: `66 agents` (36×), `all 66` (26×), `66 AI agents` (19×), `66, across` (2×), `15 across 5 departments` (2×).

   The two occurrences of "66, across 10 departments" in `dashboard/docs/agents.html` are the highest-stakes: one is inside a scored JSON-LD `FAQPage` answer (line ~38), one is prose (line ~332).

   **Edit tracked files only.** The gitignored `auto-research/asset/` and `history/` copies regenerate from the seed, and `history/` is an immutable record of past iterations that must not be rewritten. Fix `seed/landing-seo.html` plus the two hard-coded checks in `instructions.md` and `score.js`, or the generator re-introduces the old numbers on its next run.

   Ship this *with* P0 — a department whose own headline feature is the canonical-facts shelf cannot land while making the drift it exists to fix measurably worse.

   **Canon sites outside `dashboard/` and `auto-research/`.** The sweep's declared scope misses four tracked files that assert the counts. Two are user- or machine-facing and must be updated; two are internal and are deliberately left:

   | File | Facing | Action |
   |---|---|---|
   | `README.md` | Public — open-core GitHub front door; the counts appear in the opening paragraph, the ASCII diagram, the roster prose (~line 54), and both license descriptions | **Update.** Also needs a feature entry — see item 8. |
   | `agent-worker/agent.js:27` | User — the Atlas voice agent's system prompt; it *speaks* "66 AI agents across 10 departments" in conversation | **Update.** A voice agent stating a wrong count is the most visible failure mode of all. |
   | `lib/a2a.js:31` | Machine — the published A2A agent-card description, read by external agents | **Update.** |
   | `server.js:3592`, `.claude/commands/ship.md:10` | Internal comments / procedure doc | Leave; see the N2 reasoning at the end of §8. `ship.md`'s canonical-numbers line is procedure, not a claim about the product. |

8. **Release procedure — `tools/check-copy-drift.js` is CI-gated, and a new department is a public-surface feature.** `.claude/commands/ship.md:10` sets the contract and `.github/workflows/ci.yml:51` enforces it. Four surfaces must change **in the same commit**.

   **Be precise about which failure this guards against.** The check verifies that every entry in its own `FEATURES` manifest appears on the surfaces — so the two ways to get this wrong are asymmetric: adding the manifest entry without the copy **fails CI loudly**, while shipping the department and *skipping the manifest entry* leaves CI **green while the copy drifts silently**. The second is the dangerous one, and it is exactly the failure the check's header records (the copy fell ~10 features behind in a week because the numbers had guards and the features did not). Baseline today is green at 21/21 features, so a silent regression here would be invisible until someone read the README and noticed a department missing.

   | Surface | Requirement |
   |---|---|
   | `tools/check-copy-drift.js` | Add a `FEATURES` entry, e.g. `{ name: 'Knowledge & Records library', pattern: /knowledge & records\|company library\|document library/i }`. The pattern must match the wording actually used on the surfaces below — write the copy first, then the pattern. |
   | `README.md` | Mention the feature (plus the count fixes above). |
   | `dashboard/index.html` | Add to the landing `featureList` JSON-LD. |
   | `dashboard/docs/*.html` | **`DOCS_ENFORCE = true`** — the feature must be documented *somewhere* in the docs corpus (aggregate, not per-page). `dashboard/blog/` does not count; it is deliberately unaudited. A new docs page is the natural home, and it must meet the web-content standard (JSON-LD/FAQPage, AEO checklist) like every other docs page. |

   Order matters: the drift check's pattern is matched against the other three surfaces, so a manifest entry added before the copy exists fails CI by design. Write copy → add pattern → verify.

   Verify: `node tools/check-copy-drift.js` (exit 0).

**File manifest (P0):**

| File | New / Modified | What |
|---|---|---|
| `lib/library/catalog.js` | NEW | Pure record shape, normalize, dedupe, search predicates. |
| `lib/library/readers.js` | NEW | Allowlist access model; `canRead`; leak tripwire (re-uses `visibility.findLeaks`). |
| `tools/library-migrate.js` | NEW | Idempotent backfill of the three stores; `--dry-run`. |
| `tools/test-library-catalog.js` | NEW | Record/normalize/dedupe/search unit tests. |
| `tools/test-library-readers.js` | NEW | Allowlist-not-denylist assertions + leak tripwire over whole payloads. |
| `.claude/agents/chief-librarian.md` | NEW | Department head (frontmatter below). |
| `.claude/agents/archivist.md` | NEW | Intake agent (frontmatter below). |
| `.claude/agents/knowledge-graph.md` | MODIFIED | Description: note department = Knowledge & Records. Behavior unchanged. |
| `.claude/agents/golden-loop.md` | MODIFIED | Same note. Behavior unchanged. |
| `server.js` | MODIFIED | `library_catalog` state; `libraryLookup`; read routes; `COMMUNITY_ORG_CHART` +`library` dept; `EFFORT_ROUTING` +2 agents; `/api/vault/*` re-pointed. |
| `.magent/team.yaml` | MODIFIED | +`chief-librarian`, +`archivist` roles. |
| `ai-os-commercial/org-chart/departments.js` | MODIFIED | **Remove** `prod-knowledge` from `ADDITIONAL_AGENTS.product`. |
| `dashboard/**` — **not** `**/*.html` | MODIFIED | Product-canon sweep: 10 → 11 departments, 66 → 68 agents, 15 → 19 community. **22 tracked files** across all phrasings. **`dashboard/js/app.js` and `dashboard/llms.txt` both carry the counts and an `*.html` glob silently skips them.** Includes the scored JSON-LD `FAQPage` answers in `dashboard/docs/agents.html`. Rely on the verify gate for completeness, not on the count. |
| `README.md`, `agent-worker/agent.js`, `lib/a2a.js` | MODIFIED | Canon sites outside the swept paths: public README (counts + feature entry), the Atlas voice-agent system prompt (it speaks the count aloud), the published A2A agent card. |
| `tools/check-copy-drift.js`, `dashboard/index.html`, a new `dashboard/docs/*.html` | MODIFIED / NEW | Release procedure per `ship.md` — `FEATURES` manifest entry, landing `featureList` JSON-LD, and a docs page (`DOCS_ENFORCE = true`). **CI-gated; P0 fails CI without these.** |
| `auto-research/seed/landing-seo.html`, `instructions.md`, `score.js` | MODIFIED | The 3 **tracked** files of the 6 that carry the string. Update the seed and the two hard-coded checks so the generator does not re-introduce the old numbers. Do **not** edit `asset/` or `history/*` — gitignored, regenerated, and `history/` is a record of past iterations. |

**API routes (P0):**

*Middleware names are the ones this codebase actually has: the global `authMiddleware` on `/api/` (server.js ~222) already requires a session cookie or bearer token for every route below, so "authenticated" needs no per-route middleware. Per-route options are `requireAdmin` (server.js ~7957) and `requireClientOrAdmin` (~7968). **There is no `requireAuth`** — do not write one.*

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/library` | global `authMiddleware` | Catalog summary/stats, reader-filtered for the session. |
| GET | `/api/library/search?q=` | global `authMiddleware` | Search titles/tags/content index, reader-filtered. |
| GET | `/api/library/record/:id` | global + `canRead` | Record metadata (never raw content). |
| GET | `/api/library/record/:id/content` | `requireAdmin` OR `canRead` | Raw bytes; path resolved + basename/dirname-guarded per store. |
| GET | `/api/library/canonical` | global `authMiddleware` | The canonical-facts shelf. |
| GET | `/api/vault`, `/api/vault/:folder`, `/api/vault/:folder/:file` | unchanged from today (session/bearer; file-read stays `requireAdmin`) + reader filtering | Back-compat, now catalog-backed. See D-VAULTAUTH. |

All `/api/library/*` routes are operator-only in P0: the `CLIENT_API_ALLOW` guard (server.js ~230) 403s any unlisted `/api` prefix for the `client` role, and `/api/library` is deliberately **not** added until P2 owner-scopes the surface.

**How a request becomes a requester (rev 5, as built).** An admin session is an `operator`; anything else is a plain `person` who must be named on the record. A caller authenticating with the instance's own `API_TOKEN` has **no session at all**, so it would have fallen through to a person with an empty id and — correctly but uselessly — failed closed on everything; `authMiddleware` now marks it `req.isServiceToken` and the library treats it as an operator, because a token caller has always been able to read the vault and the library must not quietly take that away. A browser session is never an `agent`: the `all-agents` grant deliberately cannot be inherited by a human.

**Two 404-vs-403 and fail-open decisions worth knowing before P1:**
- `GET /api/library/record/:id` returns the **same 404** whether a record is absent or merely unreadable. A distinguishable "exists but you may not see it" tells someone with no right to confidential material that it exists.
- The legacy `/api/vault/*` listing filters out files that HAVE a catalog record the requester cannot read, but **leaves uncataloged files visible**. That is fail-OPEN, deliberately and only here: a file added to the vault directly, or since the last migrate, has no record yet, and hiding it would make the vault look empty after a fresh install. `/api/library/*` is the catalog-first, fail-closed surface; the legacy routes are the compatibility surface, not the security boundary.
- Content reads return **410** when the record is real but its bytes are gone, rather than 404 — store/catalog desync is expected (other subsystems delete artifacts on their own schedule) and a reconcile pass needs something to act on.

**Agent frontmatter (P0) — the two new files:**

```yaml
# .claude/agents/chief-librarian.md
---
name: chief-librarian
description: "Department head for Knowledge & Records. Owns taxonomy, cross-department lookup, routing of knowledge requests, and retention decisions (legal hold is a consult with compliance-officer/general-counsel, not this agent's call). Reads the catalog; never ingests. Use to find, classify, or decide the disposition of company knowledge; do NOT use to parse or store uploads — route that to archivist."
model: claude-opus-4-8
effort: xhigh
tools: [file-read, embedding-search]
triggers: [manual, library_lookup]
---
```

```yaml
# .claude/agents/archivist.md
---
name: archivist
description: "Intake for Knowledge & Records: format handling, dedupe, metadata, and versioning. EXTENDS lib/org/documents.js — it does not reimplement extraction or invent a second store. Use when a document is uploaded or an existing file needs cataloging; do NOT use to decide who may read a record or whether to delete one — that is chief-librarian + the approval gate."
model: claude-opus-4-8
effort: high
tools: [file-read, file-write, embedding-search]
triggers: [source_added, upload_received, manual]
---
```

**Org-chart edit (server.js `COMMUNITY_ORG_CHART.departments`, append):**
```
{ id: 'library', name: 'Knowledge & Records', icon: '📚', color: '#0d9488', employees: [
  { id: 'lib-chief', title: 'Chief Librarian', name: 'Athena', agent: 'chief-librarian', tier: 'strategic', avatar: '📚', status: 'active', reportsTo: 'ceo', desc: 'Taxonomy, cross-department lookup, retention decisions' },
  { id: 'lib-archivist', title: 'Archivist', name: 'Vellum', agent: 'archivist', tier: 'professional', avatar: '🗂️', status: 'active', reportsTo: 'lib-chief', desc: 'Intake, format handling, dedupe, metadata, versioning' },
  { id: 'lib-graph', title: 'Knowledge Manager', name: 'Archive', agent: 'knowledge-graph', tier: 'professional', avatar: '🧩', status: 'active', reportsTo: 'lib-chief', desc: 'Knowledge ingestion, semantic linking, graph visualization' },
  { id: 'lib-loop', title: 'Sync Steward', name: 'Tether', agent: 'golden-loop', tier: 'professional', avatar: '🔄', status: 'active', reportsTo: 'lib-chief', desc: 'Source-change detection, knowledge-base re-sync, staleness alerts' },
]}
```
`EFFORT_ROUTING`: add `chief-librarian` to `strategic.agents`; add `archivist` to `professional.agents`. (`knowledge-graph` and `golden-loop` are already in `professional.agents` — leave them.)

**Deliberately deferred out of P0:** uploads/dedupe/versioning (P1), clone/personnel contribution (P2), retention/dispose/legal-hold/PDF (P3), embeddings-backed semantic search (uses the existing `embedding-search` tool opportunistically; not a P0 dependency).

**Definition of done (P0):** the operator opens the library, sees every pre-existing vault/org-docs/artifacts item as a record with owner/sensitivity/readers/retention; an agent invoked with a library query receives the content only inside `<<UNTRUSTED_…>>` fences; the canonical-facts shelf returns the current product numbers from one place; `library-migrate.js` run twice produces no duplicates; **no file in `dashboard/` or `auto-research/` still claims 10 departments or 66 agents**, and a re-run of the auto-research loop does not regress them.

**Verify (P0):**
```
node tools/library-migrate.js --dry-run
node tools/test-library-catalog.js && node tools/test-library-readers.js
node tools/seclint.js --ci
node tools/test-all.js
```
Canon check — **must return nothing.** Note both properties: it tests every phrasing the DoD forbids (not just the department string, or a page asserting "66 agents" passes a green check), and it runs over **tracked files only** via `git grep`, because 3 of the 6 `auto-research/` hits are gitignored generated artifacts that regenerate from the seed and would keep this gate red forever:
```
git grep -lE "10 departments|66 agents|all 66|66 AI agents|66, across|15 across 5 departments" -- dashboard auto-research
```
Release-procedure gate (must exit 0 — see P0 item 8):
```
node tools/check-copy-drift.js
```
If a new phrasing of either count is introduced anywhere, add it to the canon pattern in the same commit — the gate is only as good as its alternation list, which is the same enumeration weakness that let a boundary guard miss the one field nobody listed.

---

### Phase 1 — Intake (uploads, dedupe, versioning; the archivist wired) — ✅ BUILT

*Six divergences from the section below, all found by building or by RUNNING it, detailed in §9 items 21-26. Where the two disagree, the code is right and this section is history. Gates: `test-library-intake.js` 57 assertions · `test-all.js` 36/36 · seclint clean · dead-code clean (after registering the new suite as an entry point and dropping four speculative exports) · dupes clean · copy-drift 22/22 · a live 21-assertion exercise of all three routes against a booted server, run twice.*

**In scope:**
- `lib/library/intake.js` (NEW): wraps `documents.extract()`, writes bytes to `org-docs` via the existing id-only path, creates the catalog record, dedupes by `contentHash`, chains versions. **Delegates all parsing + guards to `documents.js`** — no parser lives here.
- Register-in-place for files already in a store (artifacts) without re-uploading.
- `archivist` triggered on `upload_received`/`source_added`.

**File manifest:** `lib/library/intake.js` (NEW), `tools/test-library-intake.js` (NEW), `server.js` (MODIFIED — routes below).

**API routes (P1):**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/library/upload?name=` | requireAdmin + heavyLimiter + `express.raw` | Upload → `documents.extract` → land in `org-docs` → catalog record. Same raw-body shape as `/api/org/documents`. |
| POST | `/api/library/register` | requireAdmin | Catalog a file already present in a store, in place (no move). |
| PATCH | `/api/library/record/:id` | requireAdmin | Edit metadata (title, tags, sensitivity, readers, retention) — `readers` re-validated as an allowlist. |

**Definition of done (P1):** uploading a `.docx` produces a cataloged, deduped record whose bytes are in `org-docs` under a uuid (never the filename); re-uploading identical bytes is recognized as a duplicate; a changed file creates a new version linked to its predecessor.

**Verify (P1):** `node tools/test-library-intake.js && node tools/seclint.js --ci && node tools/test-all.js`

---

### Phase 2 — Clone & personnel contribution (the visibility asymmetry, from day one) — ✅ BUILT

*Divergences in §9 items 27-29. Gates: `test-library-contribute.js` 63 assertions · `test-all.js` 37/37 · seclint · dupes · dead-code clean · copy-drift 22/22 · an 18-assertion live exercise against a booted server using a REAL client-role session, both DoD halves asserted.*

**In scope:**
- `lib/library/contribute.js` (NEW, pure): builds a catalog record from a clone or personnel contribution; constructs `readers` **by allowlist** (contributor + explicitly named principals only — **never** `'all-agents'` by default); refuses any contribution whose payload trips `visibility.findLeaks` (persona/prompt/transcript/corpus/…); asserts `personaDerived === false`. Persona-derived material is structurally unpublishable to the library.
- **Passing the client-surface guard — a prerequisite, not a detail.** `CLIENT_API_ALLOW` (server.js ~230) is deny-by-default for the `client` role: every `/api` prefix not on that allowlist returns 403 *before* the route's own middleware runs. `/api/library` is not on it, so the contribute route would 403 for exactly the personnel it exists for. Two ordered steps, in the order the guard's own comment demands ("add a prefix here ONLY after that surface is owner-scoped"):
  1. **Owner-scope every library route first.** `owner`/`readers` (P0) are what makes this true; each route must resolve the caller's org via `orgKeyForSession` and filter, with no admin cross-org view of another person's contributions.
  2. **Then add the narrowest possible prefix.** Add the *exact path* `'/api/library/contribute'` — **not** the `'/api/library'` prefix, which would also hand clients the catalog listing, search, record metadata, and raw content routes. This mirrors the precedent already in the guard, where one exact `/api/org/*` path is allowlisted and the bare `/api/org` prefix is deliberately withheld for that reason.

**File manifest:** `lib/library/contribute.js` (NEW), `tools/test-library-contribute.js` (NEW), `server.js` (MODIFIED — contribute route, `CLIENT_API_ALLOW` exact-path entry, org-scoping on the library routes).

**API routes (P2):**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/library/contribute` | `requireClientOrAdmin` (server.js ~7968) **+ the exact path added to `CLIENT_API_ALLOW`** | A personnel member or a clone contributes a resource. `readers` defaults to the org allowlist, never all-agents. Persona-derived content refused with a stated reason. |

**Security boundary (called out explicitly):** this path inherits `visibility.js`'s allowlist model and `FORBIDDEN_KEYS`/`findLeaks` tripwire. **Failure mode if skipped:** a clone publishing persona-derived material into a library that *every agent reads* would leak a named person's psychological profile platform-wide — the exact asymmetry `visibility.js` exists to prevent, at maximum blast radius. The allowlist is built, tested, and shipped in P2; it is not deferred to a v2.

**Definition of done (P2):** a personnel-contributed doc is readable only by its allowlisted principals; a clone contribution defaults to a narrow reader set; an attempt to contribute anything containing a `FORBIDDEN_KEYS` field is refused and the refusal surfaced (not silently dropped); a logged-in `client` can reach `POST /api/library/contribute` **and still gets 403 on `/api/library`, `/api/library/search`, and `/api/library/record/:id/content`** — assert both halves, because the passing half alone is what an over-broad prefix looks like.

**Verify (P2):** `node tools/test-library-contribute.js && node tools/seclint.js --ci && node tools/test-all.js`

---

### Phase 3 — Retention, disposition, legal hold, PDF ingest

**In scope:**
1. **Delete + dispose through the gate.** Register two actions in `lib/safety/approval.js` `ACTION_RISK`: `'library.delete-record': 'critical'` and `'library.retention-dispose': 'critical'` (matching the `web-studio.delete-site` precedent — irreversible). Add matching `ACTION_EXECUTORS` entries in server.js. Both executors **refuse when `legalHold` is set** (defence in depth beyond the gate). See D-ALWAYSGATE for the open question of whether these should also join `ALWAYS_GATE`.
2. **Legal hold.** A route to set/clear `legalHold` that first runs an advisory consult with `compliance-officer` + `general-counsel` (their output is fenced untrusted like everything else); the human sets the flag.
3. **PDF ingest — real work, not a TODO.** MODIFY `lib/org/documents.js`: add `'pdf'` to `SUPPORTED`, add a `fromPdf(buffer)` parser, remove `pdf` from `REFUSALS`, and add a page/size ceiling analogous to `MAX_SHEET_ROWS` (e.g. `MAX_PDF_PAGES`). **Dependency decision (Type 1 — see D-PDF):** the repo carries *no* PDF library today (`docx` 9.7.1 is a generation lib, not extraction; `adm-zip`/`exceljs` are what `documents.js` already uses). A pure-JS PDF text extractor must be added, verified against `package.json`, and approved as a new dependency before this phase starts.
4. **Provenance on outward publish.** When a record is published outward, attach an Ed25519 sidecar via `signProvenance` (server.js ~1530) and set `provenanceId`.

**File manifest:** `lib/safety/approval.js` (MODIFIED), `lib/org/documents.js` (MODIFIED — PDF), `server.js` (MODIFIED — executors + routes), `tools/test-library-retention.js` (NEW), `tools/test-org-documents.js` (MODIFIED — PDF cases), `package.json` (MODIFIED — PDF dep, pending D-PDF).

**API routes (P3):**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| DELETE | `/api/library/record/:id` | requireAdmin | → `gateAction('library.delete-record')`. Refused if `legalHold`. |
| POST | `/api/library/record/:id/dispose` | requireAdmin | → `gateAction('library.retention-dispose')`. Refused if `legalHold`. |
| POST | `/api/library/record/:id/legal-hold` | requireAdmin | Set/clear `legalHold` after the Legal consult. |
| POST | `/api/library/record/:id/publish` | requireAdmin | Sign with `signProvenance`, set `provenanceId`. |

**ACTION_EXECUTORS entry shape (matches existing entries, server.js ~2694):**
```
'library.delete-record': async ({ recordId }) => { /* re-check legalHold at execution time; remove
    the catalog record; remove the underlying bytes ONLY if no other record shares the contentHash */ },
'library.retention-dispose': async ({ recordId }) => { /* re-check legalHold + retention policy at
    execution time (a hold can land while an approval sits in the queue); dispose per policy */ },
```
(Pseudocode intent only — the Coder writes the bodies. Note the re-check-at-execution-time discipline, copied from `clone.dispatch-agent`.)

**Definition of done (P3):** a delete request in supervised mode queues a `critical` approval and only removes bytes on approval; a record under legal hold cannot be deleted or disposed even in `auto` mode via the `legalHold` refusal; a `.pdf` uploads and extracts text through the *same* allowlist and size guards as `.docx`; a published record carries a verifiable Ed25519 sidecar.

**Verify (P3):** `node tools/test-library-retention.js && node tools/test-org-documents.js && node tools/seclint.js --ci && node tools/test-all.js`

---

## 7. Security boundaries this design touches (and the guard each inherits)

Every boundary the department crosses reuses an existing, proven guard. Nothing here invents a new security primitive.

| Boundary | Inherited guard | Where enforced |
|---|---|---|
| **Untrusted read (the load-bearing one)** | `fenceUntrusted` + `executeAgent({untrusted})` — content is DATA, never instruction | `libraryLookup` → every agent read. **No trusted-tier bypass exists.** |
| Path traversal on content read | **Per store, not one rule** — vault: `basename`+`dirname` (flat only); org-docs: id-only (`orgDocTextPath`); artifacts: `path.relative` containment assertion, because it is a nested tree and `basename` cannot express a valid path in it. See the §4 table. | `/api/library/record/:id/content`, migration, intake |
| Upload format / size / zip-bomb | `documents.SUPPORTED` allowlist + `MAX_UPLOAD_BYTES` + `readZipEntry` ratio/size ceiling | `lib/library/intake.js` (delegates), `/api/library/upload` |
| Reader access (asymmetry) | `visibility.js` allowlist builders + `FORBIDDEN_KEYS` + `findLeaks` | `readers.js`, `/api/library/contribute` |
| Irreversible delete / dispose | `approval.js` risk policy + `gateAction` + `legalHold` refusal | P3 executors + routes |
| Outward publish integrity | `provenance` Ed25519 `sign`/`verify` via `signProvenance` | `/api/library/record/:id/publish` |
| Multi-tenant scoping | `membership.orgKeyFor`/`sessionOrgKey` | `owner`/`readers` on every record |
| Client role reaching operator tools | `CLIENT_API_ALLOW` deny-by-default prefix guard (server.js ~230) | `/api/library/*` unlisted in P0; only the exact `/api/library/contribute` added in P2, after org-scoping |
| Baseline authentication | global `authMiddleware` on `/api/` (server.js ~222) — session cookie or bearer, `/api/library` never added to `publicPaths` | every library route, before any per-route guard |

---

## 8. Key risks & open decisions

**Decisions to settle before / during Phase 0:**

- **D-COMM — community vs commercial placement (Type 1, settled: community).** The Memory Vault the department absorbs is a *community* surface: its routes are core (server.js), not license-gated, and every agent on every tier reads it. Gating the department behind a license would break the "every agent reads the library" purpose on Community installs. So the department, its catalog, its read choke-point, and all four agents are **community** (added to `COMMUNITY_ORG_CHART`). This makes it community department #6 and platform department #11. Consequence: community's placed roster goes 15 → 19; the licensed headline agent count goes 66 → 68 (two new agent files; the two relocated ones already have files). Any *scale* feature (per-org quotas, advanced semantic search) can later be a commercial overlay, but the base is community. Alternative rejected: commercial placement — loses the universal-read guarantee for Community and contradicts the surface it inherits.

- **D-KG — knowledge-graph is already placed (must be moved, not just added).** Verified: `knowledge-graph` sits in the **commercial** `product` dept as `prod-knowledge` ("Archive"), reportsTo `prod-lead`. Relocation = delete that entry from `ai-os-commercial/org-chart/departments.js` **and** add `lib-graph` here. Net effect: knowledge-graph moves from commercial-visible to community-visible — consistent, because its agent file, `team.yaml` entry, and `knowledge-categorize` skill already live in the open-core repo; only its org placement was commercial. `golden-loop` is a pure add (genuinely unplaced).

- **D-VAULTAUTH — reader filtering on the legacy vault routes (Type 2, reversible; corrected in rev 2).** The vault reads are **not public.** `authMiddleware` is mounted on all of `/api/` (server.js ~222), `/api/vault` is absent from `publicPaths`, and the fallthrough requires a valid `ai-os-session` cookie or a bearer token. What is true is narrower and still worth acting on: `GET /api/vault`, `/api/vault/search`, `/api/vault/context` and `/api/vault/:folder` carry **no per-route guard**, so *any authenticated principal* reaches them, while file-read and writes are `requireAdmin`. The `client` role is separately walled off by `CLIENT_API_ALLOW`, so in practice today's exposure is "any logged-in operator-role session."

  Recommendation: leave the legacy routes at their current session-auth level and **add reader filtering** — a `confidential`/`restricted` record is invisible through `/api/vault/*` regardless of who is asking. Do **not** widen them.

  **The earlier draft of this decision recommended keeping the legacy routes "public for back-compat." That was wrong and must not be implemented** — there is no public access to preserve, so honoring it would have *created* an anonymous read path into the catalog. There is no behavior change here needing operator sign-off; reader filtering is a straight tightening.

- **D-ALWAYSGATE — should library delete/dispose join `ALWAYS_GATE`? (Type 1).** `ALWAYS_GATE` today is reserved for self-modifying-code actions and hard-stops them even in `auto` mode. `web-studio.delete-site` is `'critical'` but *not* in `ALWAYS_GATE`. Company records are arguably as irreversible as a site teardown. Recommendation: ship as `'critical'` (matching the site-delete precedent) and let the operator decide whether records deletion warrants the stronger, mode-independent hard-stop. Not the Architect's call to make unilaterally.

- **D-PDF — the PDF dependency (Type 1, irreversible-ish: a new dep on a security-sensitive ingest path).** No PDF extractor exists in `package.json`. Constraints for the chosen library: pure-JS (the repo deliberately avoids native deps — see the `lib/provenance` and `lib/crm/db.js` headers), permissive license, actively maintained. Candidates must be **verified present/installable and approved** before P3 — this spec does **not** name one as available, because none is. The Coder confirms availability + license; the operator approves the dependency addition.

- **D-LANDING — one landing zone confirmed = `org-docs`.** New uploads land in `.magent/org-docs/` via `documents.js`. Alternative rejected: a dedicated `.magent/library/files/` — that would be the fourth physical store the brief forbids and would fork the store the archivist is meant to extend.

**Open questions the mission is silent on (flagged, not invented):** `.magent/mission.md` is the generic lab mission and says nothing about the library; its only relevant constraints are "file-based architecture," "4GB-RAM VPS," and "human-in-the-loop for irreversible actions" (which this design honors via the gate). It specifies **no** retention period, **no** max library size, and **no** per-org quota. Per "don't design around imagined requirements," these are surfaced as questions rather than guessed:
- Default retention period? P0 ships `{policy:'keep'}` (never auto-expire) until the operator sets one.
- Max catalog size / per-org document quota? Unspecified — no ceiling is invented; flag for the operator, especially against the 4GB-RAM constraint.
- Sensitivity default for *new* uploads — `internal` proposed; confirm.

**Risks:**
- **[Highest — security] A single un-fenced read path.** If any caller ever splices library content into a task string or `systemOverride` instead of the `untrusted` array, one hostile document reaches every agent on every tier. Mitigation: `libraryLookup` is the *only* sanctioned read; the P0 tests assert its return shape is the fenced envelope; code review rejects any direct `catalog → task` concatenation. This is the invariant the whole department is subordinate to.
- **Reader allowlist regressions.** A future field added to the record must not widen access. Mitigation: `readers` is an allowlist and the `findLeaks`-style test runs over whole responses (the `visibility.js` discipline), so a leak fails the suite, not a human reviewer's memory.
- **Migration double-writes.** A non-idempotent backfill would duplicate every record on re-run. Mitigation: dedupe by `store`+`path`+`contentHash`; `--dry-run` first.
- **Store/catalog desync.** The catalog points at bytes that could be deleted out from under it (e.g. a vault file removed directly). Mitigation: content read returns a clear `410`-style "no longer on disk" (the `org-docs` precedent), and a `library-migrate --reconcile` pass prunes dangling records.
- **PDF as an attack surface.** A PDF parser is a classic parser-bug target. Mitigation: it lives *inside* `documents.js` behind the same size/bomb ceilings, and its text output is untrusted like every other format's — a parser bug cannot escalate past the fence.
- **Canonical-facts staleness moves, it doesn't vanish.** The shelf fixes N-copies drift, but the shelf itself can go stale. Mitigation: the shelf is the *single* place to update, and (systems-over-goals) the existing auto-research loop that generates product numbers should write to the shelf rather than to scattered copies — the durable fix is upstream, at the generator.

---

## 9. Divergences from the briefing (found in the codebase, flagged rather than designed around)

1. **`knowledge-graph` is NOT department-less.** It is placed in the commercial `product` department (`prod-knowledge`, "Archive", `ai-os-commercial/org-chart/departments.js`). Relocation must remove it there. (`golden-loop` *is* department-less — the briefing is correct for it.)
2. **The vault folder allowlist is hardcoded in more than four places.** Verified occurrences of `['raw','wiki','outputs']` in server.js: `getVaultStats` (~4398), `searchVault` (~4427), `GET /api/vault/:folder` (~5669), `GET /api/vault/:folder/:file` (~5693), `POST /api/vault/:folder` (~5709) — five in server.js, plus `tools/generate-maps.js` (`buildVaultMap`) likely a sixth. The briefing's "four places" is an undercount; the migration/back-compat work must touch all of them.
3. **`docx` (9.7.1) in `package.json` is a generation library, not an extractor.** `documents.js` extracts `.docx` by unzipping with `adm-zip` and stripping XML by hand — so PDF cannot piggyback on any existing dependency. This *confirms* the briefing's "PDF needs a dependency this repo does not carry": there is genuinely no reusable parser, and the PDF dep is fully net-new.
4. **The artifacts store is sparsely populated.** Of `.magent/artifacts/{code,docs,media,research,web-studio,youtube}`, only `docs/` currently contains files. "Register in place" will catalog whatever exists and no more — the design does not assume the other subfolders are present.
5. ~~**The current vault read routes are public.**~~ **Withdrawn in rev 2 — this was wrong.** The vault reads are behind the global `authMiddleware` (server.js ~222) and require a session cookie or bearer token; they are absent from `publicPaths`. The accurate finding is that they carry no *per-route* guard, so any authenticated operator-role session reads them while writes are `requireAdmin`. Reader filtering is therefore a straight tightening with nothing public to preserve. See the corrected D-VAULTAUTH.

6. **`requireAuth` does not exist in this codebase.** The route tables in the first draft named it. The real middlewares are `requireAdmin` (server.js ~7957) and `requireClientOrAdmin` (~7968), with the global `authMiddleware` already requiring authentication on every `/api/` route. Corrected throughout §6; do not create a `requireAuth` to satisfy the spec.

7. **`CLIENT_API_ALLOW` was missing from the design entirely.** The deny-by-default client-surface guard (server.js ~230) 403s any unlisted `/api` prefix for the `client` role before per-route middleware runs, which would have made P2's personnel-contribution route unreachable by personnel. Now handled as an ordered prerequisite in Phase 2, with the exact-path-not-prefix discipline the guard's own comment requires.

8. **Creating this department breaks the product canon.** `10 departments` is hard-coded in 27 files across `dashboard/` and `auto-research/`, including scored JSON-LD. Revision 1 stated the new counts but did not manifest the sweep; revision 3 corrected its scope (see items 10-11). Now a required P0 item with its own verify command — including the auto-research seed, without which the generator re-introduces the old numbers.

9. **The vault guard does not generalize to the artifacts store** (rev 3, from Reviewer B3). The schema originally claimed one "basename/dirname-guarded" read rule inherited from the vault routes. That guard is correct only for a flat directory; `artifacts/` is a nested tree, so `basename` cannot express a valid path in it. Now specified per store in §4, with `path.relative` containment as the general form. This was a P0 byte-read path, so it would have forced an unspecified design decision during implementation.

10. **The canon verify gate could never have gone green** (rev 3, found while checking Reviewer B2). Three of the six `auto-research/` files carrying the count — `asset/landing-seo.html`, `history/best/landing-seo.html`, `history/iter-001-kept/landing-seo.html` — are **gitignored generated artifacts**. A plain `grep -rl` over the directory reports them forever: editing them is pointless (they regenerate) and wrong for `history/` (a record of past iterations). The gate is now `git grep`, tracked files only. This is the same gitignored-asset / tracked-seed trap that produced the original stale-number drift, which is fitting: the sweep to fix it stepped in it.

11. **Reviewer's own count was off** (rev 3). The sign-off review reported 25 files for the department string (21 dashboard + 4 auto-research); the verified figure is **27**, because auto-research carries 6 hits, not 4. The review's substantive point — the `*.html` glob skips `app.js` and `llms.txt` — was correct and is fixed. Recorded because these numbers are now load-bearing for the sweep, and because the coincidence is a trap: the sweep the Coder performs is also *25* files, but a different 25 (22 dashboard + 3 auto-research, all phrasings, tracked only). Do not reconcile the two figures — they count different things.


---

12. **The design was blind to the repo's own release procedure** (rev 4, found post-approval while checking Reviewer O2). `tools/check-copy-drift.js` is CI-gated at `.github/workflows/ci.yml:51`, and `.claude/commands/ship.md:10` requires a public-surface feature to land in `README.md`, the landing `featureList` JSON-LD, and the drift-check `FEATURES` manifest in one commit — with `DOCS_ENFORCE = true` additionally demanding a docs page. Both review passes missed this, and O2 ("README carries a stale count") was its visible edge: the README needs a *feature entry*, not just a number fix. Now P0 item 8. Worth stating plainly: **the spec was approved in a state that would have shipped a department the public copy never mentions** — and because the drift check only polices its own manifest, CI would have stayed green throughout. Two review passes read the document carefully; neither ran the repo's gates against it. That is the argument for executing a plan's own verify commands during review, not only reading them.

### Found by building it (rev 5)

*Every item here was found by running the code. Three review passes over the prose — one architect, two reviewer — found none of them. That is the most useful thing in this section: the failures that survive careful reading are the ones only execution exposes.*

13. **A fact's value was in a tag.** `factValue()` read the record's first tag, because §4 had no value field. Tags are an unordered set, so `tags:['counts','68']` answered `"counts"` and any future tag sort would have broken every fact silently. `value` was added to the schema (§4).

14. **`readers:['all-agents']` did not preserve the vault's behaviour.** §4 said it did. The legacy vault is readable by any authenticated operator; `all-agents` admits agents only. As specified, every human would have opened the library to an empty vault. Fixed by adding the `all-operators` sentinel and an `operator` requester kind, kept separate from `all-agents` because agent reads are fenced and human reads are not. The kind→sentinel mapping is a table, not branches, so adding a requester kind forces an explicit decision about its broad grant rather than inheriting one.

15. **The canonical-facts shelf destroyed itself on first migrate.** Facts have no bytes, so they were seeded with `path:''` and `contentHash:''` — one shared dedupe key, five facts, one survivor. The shelf built to end silent numeric drift lost 80% of its contents without an error. Fixed with a synthetic path plus a hash of the value; regression-tested from both directions.

16. **`basename` rewrites rather than refuses.** `wiki/../../../../etc/passwd` flattened to `<vault>/wiki/passwd` — contained, so not a traversal, but a different real file than the record names. `..` is now refused as a segment in every store (§4).

17. **The seed crashed on a temporal dead zone.** `seedCanonicalFacts()` counts `ORG_CHART`, which is built ~2,700 lines below where the library section sits, so calling it at module load threw `Cannot access 'ORG_CHART' before initialization`. Seeding moved into `ensureCanonicalFacts()`, called immediately after the org chart is assembled. Worth recording because **`node --check` cannot see a TDZ violation** — only booting found it.

18. **Four canon sites in `server.js` that §6 P0 item 7's table did not list.** The table was built from a `git grep` over `dashboard/` and `auto-research/` plus three named files; these were outside all of it:
    - **`server.js:4152` — a SECOND Atlas system prompt.** The dashboard text-chat endpoint, distinct from the LiveKit voice agent at `agent-worker/agent.js:27` that the table did name. It told users "66 AI agents across 10 departments." Live, user-facing, and it would have passed every gate this document specifies.
    - `server.js:8693` and `:8775-8777` — comments that had become factually wrong about the code directly beneath them (one annotated an object that already had 6 departments while saying 5).
    - `server.js:9599` — stale `onScreenText: '66 Active Agents'` in sample data.

    The lesson generalises past this sweep: a count appears wherever a human wrote a sentence about the product, including inside prompts, comments, and mock data. Grepping the *copy directories* finds the copy; it does not find the product describing itself in code.

19. **A pre-existing arithmetic gap was preserved, not fixed.** `dashboard/docs/agents.html` states "45 named employees + 12 system agents", which did not sum to the total before this work either (a gap of 9). The sweep left it as-is rather than inventing a correction to unrelated stale math. Flagged as its own small task, not folded into a department build.

20. **The commercial repo had no commits at all.** Every file in `ai-os-commercial` was untracked, so the `prod-knowledge` removal — and everything else in the private half of the open-core split — had no history and no recovery path. Given an initial commit (`6bfa62a`) with the `.gitignore` it also lacked, which matters more there than in most repos: that code validates license keys, so a committed `.env` would be a licensing bypass rather than only a leak. Verified before committing: no `node_modules`, no `.env`, no key or PEM files, no secret-shaped strings.

### Found by building P1

21. **`intake.js` is PURE — the route writes the bytes.** P1's manifest says the module "writes bytes to `org-docs`". It does not: it returns a duplicate/version/new decision and the handler performs the I/O. Same reasoning as rev-5 lesson #5 (`paths.js`): this module decides whether someone's second upload silently overwrites their first, and a decision reachable only by POSTing a real file to a booted server is one nobody re-verifies. The dedupe and chaining rules now have 57 assertions with no server involved.

22. **`supersedes` is a real field, not a tag.** §4 offered "`tags`/a `supersedes` note". Tags are an unordered, deduped, capped set — which is *precisely* rev-5 defect #1, where a canonical fact's payload lived in its first tag. A version pointer has the same failure shape and fails in the direction that loses history. Added to `normalizeRecord` and covered in `test-library-catalog.js`.

23. **There is no `upload` source, and inventing one does not fail loudly.** The first implementation set `source:'upload'`, which is not in `VALID_SOURCES`; `normalizeRecord` does not throw on an unknown source, it falls back to `'agent-output'`. Every company document an operator uploaded would have been cataloged as something an agent produced — a mislabelling the chief-librarian's taxonomy could never sort out afterwards. Uploads are `'company-doc'`; `planRegister` now *validates* its source rather than defaulting it.

24. **`personaDerived` needed a second check, at the boundary.** `normalizeRecord` throws on `true`, which is right for a programmer error and wrong for an HTTP body — a route would 500 where it should 400. Intake builds an explicit field list, so the flag never reached the throw at all: a caller could send it, be silently ignored, and believe the record was marked. Now refused by name in both `planIntake` and `planRegister`, with the throw kept as the backstop for callers that bypass intake.

25. **`CLIENT_API_ALLOW` is unchanged, deliberately.** All three P1 routes are `requireAdmin`, so P0's note still holds and the prefix stays out. Adding `/api/library` now "to save a step in P2" would hand every managed client the catalog listing, the search and the raw content along with the contribute route.

26. **The live exercise lied twice before it told the truth**, and both lies looked like product bugs. (a) Unauthenticated POSTs returned **400, not 401** — the app-level body parser rejects malformed JSON *before* any route middleware, so the script was testing the parser while appearing to test auth. With valid bodies all three routes 401 correctly. (b) Fixtures with constant content reported `duplicate` where the script expected `new`, on every run after the first — because dedupe is keyed on content hash in *persisted* state and is global rather than scoped to a title, which is the design working. **A test whose fixtures are not unique per run cannot test a content-addressed store**, and the failure presents as the feature being broken.

---

**Accepted as-is from the sign-off review, with reasons (rev 3):**
- **`server.js:3592` hard-codes "66 agents" in an internal comment** (Reviewer N2). Deliberately left outside the sweep's declared scope, which is user-facing copy plus the generator. A stale internal comment misleads a reader; a stale JSON-LD answer misleads a search engine and a customer. Fixing it is welcome in passing, but adding non-user-facing comments to the verify gate would make the gate noisy and eventually ignored.
- **Line-number anchors drift by a few lines** (Reviewer N5 — `orgDocTextPath` ~11049 vs 11053, `getVaultStats` ~4393 vs 4395, `ACTION_EXECUTORS` ~8629 vs 8633). Every anchor uses the `~` convention and every symbol was verified present within a handful of lines. Chasing exact line numbers in a doc that will outlive them is false precision; the symbol name is the durable locator and every one of them is correct.

---

### Found by building P2

27. **A route can disarm a module's tripwire by pre-filtering the payload.** `planContribution` scans
    its whole input with `findPersonaLeaks`, and the first version of the route forwarded a
    hand-picked subset — `kind`, `title`, `text`, `principals`, `tags`. A body carrying a full
    `persona` object therefore never reached the guard and was accepted with a **200**. The guard was
    correct, unit-tested, and bypassed by the code that called it. The route now spreads the whole
    body and overrides the trusted fields on top. **Only the live exercise caught this**; every unit
    test passed, because the module was never the broken part.

28. **The operator override had to be narrowed, and as an allowlist.**
    `/api/library/record/:id/content` let an admin read past `readers` entirely. That is right for
    the instance's own material and wrong for a contribution, whose narrow reader set would otherwise
    be decorative — the same cross-account view the clone doctrine already refuses.
    `readers.OPERATOR_OVERRIDABLE_SOURCES` names the three sources it MAY reach, so a source added
    later is denied by omission rather than disclosed by it.

29. **`MAX_TEXT_CHARS` was nearly declared twice.** The first draft restated the constant with a
    comment claiming "one ceiling, not two" — which described the intent while creating the second
    one. The dead-code gate flagged it as a duplicate export; it is now imported from `documents.js`,
    which owns what "too long" means.

    Also worth recording, because it cost twenty minutes and looked like a server bug: **PowerShell
    cannot hold a `localhost` session cookie.** .NET's `CookieContainer` silently refuses cookies for
    a hostname with no dot, so `-SessionVariable` captures zero cookies and every authenticated
    request returns 401. Pull the token from `Set-Cookie` and send it as Bearer — the server accepts
    either, so the guard path tested is identical.

## 10. Requirement coverage map

Every locked decision and required content item, mapped to where it is addressed.

| Requirement (from the brief) | Addressed in |
|---|---|
| Dept id `library`, name "Knowledge & Records", #11 | §1, §3, §6 P0, D-COMM |
| Community vs commercial placement, justified | §8 D-COMM (community, with the vault-is-community reasoning) |
| Four seats (head, archivist, kg relocated, golden-loop relocated) | §3 table, §6 P0 org-chart edit |
| No retention/records officer; consult compliance-officer + general-counsel | §3, §6 P3 legal-hold route |
| Catalog over stores, no new store | §2, §4, D-LANDING |
| Concrete catalog schema (id/title/source/owner/sensitivity/readers/retention/path/hash/added-by/added-at) | §4 (full schema, superset) |
| Migration path for vault/wiki + org-docs; artifacts in place | §6 P0 `library-migrate.js` |
| Untrusted-by-default, no trusted tier, failure mode spelled out | §1, §2, §7, §8 (top risk) |
| Clone-authored visibility asymmetry, allowlist, day one | §4 `readers`, §6 P2, §7 |
| Delete/dispose through the Auto-Mode gate, in its actual shape | §6 P3 `ACTION_RISK`/`ACTION_EXECUTORS`/routes |
| Provenance reuse (Ed25519) on outward publish | §5, §6 P3 publish route |
| PDF ingest as real work + dependency decision | §6 P3, §8 D-PDF |
| Per-phase file manifest (new/modified), routes+auth, agent frontmatter, team.yaml + org-chart edits, verify | §6 each phase |
| Gotchas in the lib/org header voice | §11 |
| Security-boundary callouts + inherited guard | §7 |
| Canonical-facts shelf as the stale-number fix | §1, §6 P0 item 4, §8 (staleness risk) |
| Flag codebase-vs-briefing contradictions | §9 (20 items after rev 5; items 13-20 came from building it) |
| P0 as built, with commits and green gates | Status block at the top |
| `value` field + fact identity | §4 schema + the fact-identity note |
| Two sentinels / requester kinds | §4 `readers`, §6 P0 requester derivation, §9 item 14 |
| `..` refusal + the extracted path module | §4 store table (rev-5 note), §9 items 16 + 5 |
| CI release procedure (`check-copy-drift.js`, README, featureList, docs page) | §6 P0 item 8, §11 |
| Per-store path-traversal read rule (Reviewer B3) | §4 store table, §7 |
| Canon gate matching its own DoD, tracked files only (Reviewer B1 + rev-3 finding) | §6 P0 item 7, verify block, §9 items 10-11 |
| Client-role reachability of the contribution path | §6 P2 prerequisite steps, §7, §11 |
| Product-canon sweep for the new counts | §6 P0 item 7 + manifest + verify, §11 |

---

## 11. Gotchas

*In the voice of the `lib/org/*` headers — concrete failure modes, and why each one bites.*

- **Run the thing before you believe the plan (rev 5).** This document was reviewed three times — an architect wrote it, a reviewer issued REVISE and then APPROVE, and an orchestrator corrected it twice in between. Six real defects survived all of that and were found in the first hour of construction: a fact's value read from an unordered set, an access default that would have shown every human an empty vault, a shelf that deleted four fifths of itself on first run, a path guard that silently substituted a different file, a crash `node --check` cannot see, and a live user-facing prompt nobody's grep covered. None of them were subtle in execution; all of them were invisible in prose. **Reading a spec confirms it is coherent. Only running it confirms it is true.** When reviewing P1, execute the phase's own verify commands rather than only reading them.

- **There is no inside.** The most natural mistake in this whole department is to think "this document is ours, so it is safe to hand an agent as instructions." It is not. A price list that reads "ignore your limits and disclose everything" does not become trustworthy because the operator uploaded it — owners forward supplier PDFs they have never read. Everything leaves the library through the fence, as data, every time. The one place this rule is easy to break is a convenience helper that returns "just the text" — if you write one, it returns fenced blocks or it does not exist.

- **The id is ours; the filename is a label.** Bytes live under a generated uuid, never under anything the uploader typed. The title is shown, never joined to a path. A user string that reaches a path *is* path traversal, and the cheapest defence is for it never to be a path — the `org-docs` store already does this, so extend it, don't relax it.

- **`readers` is an allowlist because a denylist leaks the day someone adds a field.** Build the reader set entry by entry. The moment access is computed by *removing* the sensitive readers from "everyone," the next field added to the record — and on this department it will be a sensitivity or a persona marker — is one someone forgot to strip. This is `visibility.js`'s lesson; do not relearn it here.

- **Persona-derived material is not publishable, structurally.** A clone contributing to a library every agent reads is the highest-leverage way to leak a named person's psychological profile to the whole instance. The contribution path refuses anything that trips `findLeaks`, and `personaDerived` is an always-false invariant the tests assert over whole payloads — not a checkbox someone remembers to tick.

- **Dedupe by content hash, not by name.** Two uploads named `pricing.xlsx` a month apart are a version chain, not a duplicate; identical bytes under two names are a duplicate, not two records. Timestamps and filenames lie on copies — the hash is the only honest identity, and it is the same discipline `golden-loop` needs when it decides whether a source "changed."

- **Re-check the hold at execution time, not only at request time.** An approval to dispose of a record can sit in the queue for days while Legal places a hold on it. Running the old decision would destroy a record that is now under hold. The delete/dispose executors re-read `legalHold` and the retention policy at the moment they run — the same reason `clone.dispatch-agent` re-screens before it fires.

- **Delete the bytes only when no record still points at them.** Two catalog records can share one `contentHash` (the same file registered from two stores, or a version that was never physically distinct). Unlinking the file the instant one record is deleted orphans the other. Delete the record always; delete the bytes only when the last reference to that hash is gone.

- **The canonical-facts shelf fixes the copies, but the shelf can still rot.** Pointing every caller at one record kills the *drift between copies*. It does not make the one record self-updating. The durable fix is to make the upstream generator (the auto-research loop that produces product numbers) write to the shelf, so there is one writer and one reader — otherwise you have moved the stale number, not retired it.

- **The vault allowlist lives in more places than you think.** `['raw','wiki','outputs']` is hardcoded in at least five spots in server.js and probably a sixth in the map generator. Re-pointing the vault through the catalog means finding all of them; a half-migrated vault where one route still reads the folder directly is a record the catalog's `readers` guard never sees.

- **Two guards stand in front of every route here, and neither is the route's own middleware.** `authMiddleware` decides whether the caller is anyone at all; `CLIENT_API_ALLOW` decides whether a `client` may see this prefix — and it answers 403 *before* the handler's `requireAdmin` ever runs. So a route can look correctly guarded, test green as an operator, and be silently unreachable for the exact role it was written for. That is how P2's contribute route was specced broken. When you add a library prefix to that allowlist, add the **exact path**: `'/api/library'` would hand a client the catalog listing, search, and raw content along with the one route you meant. And when you assert it works, assert the 403s too — the passing half alone is indistinguishable from an over-broad prefix.

- **This repo already has a canon gate, and it is not the one this doc invents.** `tools/check-copy-drift.js` runs in CI and checks that every entry in its `FEATURES` manifest appears in `README.md`, the landing page, and the docs corpus. A new department is a public-surface feature, so P0 must add it to all four places in one commit or CI rejects the build — and the drift check's pattern is matched *against* the copy, so adding the manifest entry before writing the copy fails by design. Write copy, then pattern. The grep gate this doc specifies covers stale *numbers*; the drift check covers missing *features*. They are complementary and you need both, which is precisely the lesson the drift check's own header records: the numbers had guards, the features didn't, and the copy fell ten features behind in a week.

- **Adding a department is a product-copy change, not just a code change.** The count is a fact about the product, and it is carved into 27 files plus a scored JSON-LD block plus the auto-research generator's own checks and seed. Edit only the pages and the generator re-writes the old number back on its next run; edit only the generator and the pages stay wrong until it runs. This department exists partly to end that pattern, which makes shipping it with a stale count the one failure mode nobody would let us live down — and the durable fix is the shelf plus one writer, not a more careful sweep next time.

- **Registering artifacts in place is not the same as owning them.** The artifacts tree is transient agent output that other subsystems write and delete on their own schedule. Catalog it lightly, expect records to go dangling, and reconcile — do not assume a record written today points at a file that exists tomorrow.
