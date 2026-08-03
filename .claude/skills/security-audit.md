---
name: security-audit
description: AI-powered web security assessment — architecture review, vulnerability scanning, dependency audit, deployment hardening, and blue team recommendations.
category: security
rubric: security
estimated_time: 30min
source: https://github.com/wholefoo/mythos-defense
---

# Security Audit

## Goal
A findings report an engineer can work from today: each issue names the file and line, says what an
attacker gets, and carries a fix that can be applied and tested. Severity reflects real exploitability
in this deployment, not a generic CVSS band.

## What good looks like
- Every finding names a concrete location — file and line, endpoint, or config key. A finding with no
  location cannot be fixed or disproven.
- Every finding states the attacker's gain: what they can read, write, or run. "Insecure pattern" with
  no consequence is a lint result, not a security finding.
- Severity is justified against this target's actual exposure. A critical CVE in a dev-only dependency
  is not critical here, and saying so is part of the assessment.
- Dependency findings carry the real CVE identifier and the fixed version, both verified against an
  advisory retrieved in this run — not recalled.
- Every proposed fix is specific enough to apply, and its own risk of breaking something is stated.
- Components the scan could not reach are listed as unexamined. Silence about a subsystem reads as a
  clean bill of health, and that is how a whole subsystem goes unaudited.
- No finding appears twice under two names because two tools flagged the same thing.

## Guardrails
- Never modify the target. This produces findings and patches; applying them is a separate, gated act.
- Never test against a host the operator did not name as in scope.
- Never include a live secret, token, or credential in the report — reference its location instead.

## Team
- **safety** — scope, and whether the assessment itself stays within bounds
- **security-auditor** — vulnerability identification, severity, and CVE verification
- **coder** — remediation patches for the findings that have them
- **reviewer** — whether a proposed fix introduces a new problem

## Parameters
- `target`: URL or path to codebase to audit
- `audit_type`: full | quick | dependencies-only | deployment-only (default: full)
- `framework`: auto-detect | node | python | react | express (default: auto-detect)
- `include_semgrep`: true | false (default: true)

## Output
- `.magent/artifacts/research/security-audit-{target-slug}.md` — Full security report with scored findings
- `.magent/artifacts/docs/security-remediations-{target-slug}.md` — Prioritized fix list with code patches
