---
name: seo-audit
description: Full SEO health audit — keyword research, on-page analysis, content gaps, technical checks, and competitor benchmarking with a prioritized action plan.
category: marketing
rubric: marketing
estimated_time: 30min
---

# SEO Audit

## Goal
A marketer who has never seen this site can open the report and start work the same morning: they
know which three things to fix first, why those three, and what each one is worth. Every finding is
tied to a page or a query that actually exists on the audited domain.

## What good looks like
- Every finding names the specific URL or query it came from. A recommendation that could have been
  written without visiting the site is filler, and filler is what makes an audit unactionable.
- Title tags are judged against 50–60 characters and meta descriptions against 150–160, because those
  are the truncation points in the SERP, not style preferences.
- Thin content is called out at the threshold that matters for the query type — under ~300 words for
  an informational page — and stale content at 12+ months without an update.
- The keyword table carries 15–25 opportunities with intent classified as informational,
  navigational, commercial, or transactional, sorted so the top row is the one to do first.
- Every technical check reports pass, fail, or warning — never silence. A check that could not be run
  says so and says why, because an unrun check read as a pass is how a broken robots.txt survives an audit.
- Competitor claims are comparative and sourced: "ranks above you for X" beats "has stronger content".
- The action plan splits into what fits in a week and what needs a quarter, and each item carries its
  expected impact and effort. An unsorted list of 40 fixes is a list nobody starts.
- If the target URL could not be reached, that is the first finding in the report and the audit
  continues on whatever data was available — a blank report because one fetch failed is worse than a
  partial one that says which part is missing.

## Guardrails
- Never report a metric as measured when it was estimated or inferred. Say which it was.
- No recommendation that requires access the operator has not granted (server config, DNS, analytics)
  without labelling it as such.

## Team
- **seo-technical** — crawlability, status codes, Core Web Vitals, mobile, HTTPS, structured data
- **seo-keyword** — discovery, gaps, cannibalization, volume and difficulty, intent classification
- **seo-content** — content inventory, thin and duplicate pages, topical authority, meta quality
- **seo-backlink** — referring domains, toxic links, anchor distribution, broken backlinks
- **seo-competitor** — organic competitor set, authority and velocity comparison, ranking overlap

## Parameters
- `url`: Required. The website URL or domain to audit.
- `audit_type`: full|keyword-research|content-gap|technical|competitor-comparison (default: full)
- `keywords`: Optional. Array of target keywords already being pursued.
- `competitors`: Optional. Array of competitor domains. Auto-detected if not provided.

## Output
- `.magent/artifacts/docs/seo-audit-<domain>-<timestamp>.md` — full audit report
- `.magent/artifacts/research/keywords-<domain>.md` — keyword opportunity data
- `.magent/artifacts/research/competitors-<domain>.md` — competitor analysis
