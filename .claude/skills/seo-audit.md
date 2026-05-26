---
name: seo-audit
description: Full SEO health audit — keyword research, on-page analysis, content gaps, technical checks, and competitor benchmarking with a prioritized action plan.
category: marketing
estimated_time: 30min
---

# SEO Audit Skill

## Goal
Audit a website's SEO health, research keyword opportunities, identify content gaps, and benchmark against competitors. Produces a prioritized action plan a marketer can execute immediately.

## Process
1. **Intake**
   - Collect target URL/domain from user
   - Determine audit type: full | keyword-research | content-gap | technical | competitor-comparison
   - Gather target keywords and competitor domains (optional)

2. **Keyword Research**
   - Researcher agent identifies primary, secondary, and long-tail keyword opportunities
   - Classify intent: informational, navigational, commercial, transactional
   - Assess difficulty and opportunity score for each keyword
   - Surface question-based keywords (People Also Ask patterns)

3. **On-Page SEO Audit**
   - Analyze key pages: homepage, top landing pages, recent posts
   - Check title tags (unique, 50-60 chars, keyword present)
   - Check meta descriptions (compelling, 150-160 chars, CTA)
   - Validate H1/H2/H3 hierarchy and keyword usage
   - Review internal linking, image alt text, URL structure
   - Flag keyword stuffing or thin content

4. **Content Gap Analysis**
   - Compare topic coverage against competitors
   - Identify stale content (12+ months without updates)
   - Flag thin pages (<300 words for informational queries)
   - Map missing content types: guides, comparisons, glossaries, tools
   - Identify funnel gaps: awareness, consideration, decision stages
   - Recommend topic clusters and pillar page opportunities

5. **Technical SEO Check**
   - Page speed and Core Web Vitals signals (LCP, INP, CLS)
   - Mobile-friendliness: responsive design, tap targets, viewport
   - Structured data opportunities: FAQ, HowTo, Product, Article schema
   - Crawlability: robots.txt, XML sitemap, canonical tags, noindex usage
   - Broken links, redirect chains, HTTPS/mixed content
   - Indexation issues and duplicate content risks

6. **Competitor Comparison**
   - Keyword overlap and gaps vs. each competitor
   - Content depth, publishing frequency, backlink profile signals
   - SERP feature ownership: featured snippets, knowledge panels
   - Technical advantages: speed, mobile experience, structured data

7. **Compile Report**
   - Writer agent produces structured audit document
   - Executive summary with top 3 priorities
   - Keyword opportunity table (15-25 keywords, sorted by opportunity)
   - On-page issues table with severity ratings
   - Content gap recommendations with effort estimates
   - Technical checklist (pass/fail/warning)
   - Competitor comparison matrix
   - Prioritized action plan: quick wins (this week) + strategic investments (this quarter)

8. **Review & Deliver**
   - Reviewer validates all claims and recommendations
   - Output final report to artifacts

## Parameters
- `url`: Required. The website URL or domain to audit.
- `audit_type`: full|keyword-research|content-gap|technical|competitor-comparison (default: full)
- `keywords`: Optional. Array of target keywords already being pursued.
- `competitors`: Optional. Array of competitor domains. Auto-detected if not provided.

## Agents Involved
- **Researcher**: Keyword research, competitor analysis, web data gathering
- **Writer**: Compiles findings into structured audit report
- **Reviewer**: Validates accuracy and completeness of recommendations

## Error Handling
- If target URL is unreachable → report as critical finding, continue with available data
- If no competitors provided → auto-identify 2-3 likely competitors via web search
- If research data is limited → note data gaps, recommend connecting SEO tools (Ahrefs, Semrush)

## Output
- `.magent/artifacts/docs/seo-audit-<domain>-<timestamp>.md` — full audit report
- `.magent/artifacts/research/keywords-<domain>.md` — keyword opportunity data
- `.magent/artifacts/research/competitors-<domain>.md` — competitor analysis
