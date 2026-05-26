---
name: content-creation
description: Multi-step content creation workflow — research, outline, draft, review, publish.
category: marketing
estimated_time: 15min
---

# Content Creation Skill

## Goal
Produce high-quality written content (blog posts, articles, social media) from a topic brief.

## Process
1. **Research Phase**
   - Activate Researcher agent with topic keywords
   - Gather 5-10 relevant sources
   - Identify key talking points and unique angles

2. **Outline Phase**
   - Writer agent creates structured outline
   - Include hook, main points, CTA
   - Submit for orchestrator review

3. **Draft Phase**
   - Writer produces full draft from approved outline
   - Target word count specified in parameters
   - Include SEO keywords if provided

4. **Review Phase**
   - Reviewer checks for accuracy, tone, and completeness
   - Flag any unsupported claims
   - Suggest improvements

5. **Finalize**
   - Writer incorporates review feedback
   - Output to `.magent/artifacts/docs/content-<title>.md`

## Parameters
- `topic`: Required. The subject to write about.
- `format`: blog|article|social|email (default: blog)
- `word_count`: Target length (default: 800)
- `tone`: professional|casual|technical (default: professional)
- `keywords`: Optional SEO keywords array.

## Error Handling
If research returns < 3 sources, escalate to orchestrator for topic refinement.
