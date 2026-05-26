---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes, derived from Andrej Karpathy's observations. Biases toward caution over speed.
source: https://github.com/wholefoo/andrej-karpathy-skills
---

# Karpathy Behavioral Guidelines

## 1. Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
- No features beyond what was asked.
- No abstractions for single-use code.
- No speculative "flexibility" or "configurability."
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove only imports/variables/functions that YOUR changes made unused.
- Test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
- Transform tasks into verifiable goals with success criteria.
- For multi-step tasks, state a brief plan with verification checks.
- Strong success criteria enable independent looping. Weak criteria require clarification.

## Verification
These guidelines are working if:
- Fewer unnecessary changes in diffs
- Fewer rewrites due to overcomplication
- Clarifying questions come before implementation, not after mistakes
