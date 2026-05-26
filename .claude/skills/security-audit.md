---
name: security-audit
description: AI-powered web security assessment — architecture review, vulnerability scanning, dependency audit, deployment hardening, and blue team recommendations.
category: security
estimated_time: 30min
source: https://github.com/wholefoo/mythos-defense
---

# Security Audit Skill

## Goal
Perform a comprehensive security assessment of a web application or codebase, identifying vulnerabilities, misconfigurations, and hardening opportunities using a multi-agent approach.

## Process
1. **Architecture Review** — Assess system design for security anti-patterns (exposed endpoints, missing auth layers, insecure data flows)
2. **Dependency Audit** — Scan package.json/requirements.txt for known CVEs and outdated packages
3. **Supply Chain Analysis** — Evaluate third-party dependencies for trust, maintenance status, and attack surface
4. **Code Scanning** — Run semgrep rules for common vulnerability patterns (injection, XSS, CSRF, auth bypass)
5. **Deployment Review** — Check Docker configs, environment variables, SSL, CORS, headers, and secrets management
6. **Blue Team Assessment** — Generate defensive recommendations: WAF rules, monitoring, incident response procedures
7. **Report Compilation** — Score findings by severity (critical/high/medium/low), provide remediation steps

## Parameters
- `target`: URL or path to codebase to audit
- `audit_type`: full | quick | dependencies-only | deployment-only (default: full)
- `framework`: auto-detect | node | python | react | express (default: auto-detect)
- `include_semgrep`: true | false (default: true)

## Agents Used
- **Safety agent** (Opus) — Overall security assessment coordinator
- **Security Auditor** (Opus) — Vulnerability identification and scoring
- **Coder** (Sonnet) — Fix generation for identified vulnerabilities
- **Reviewer** (Opus) — Validates proposed fixes don't introduce new issues

## Output
- `.magent/artifacts/research/security-audit-{target-slug}.md` — Full security report with scored findings
- `.magent/artifacts/docs/security-remediations-{target-slug}.md` — Prioritized fix list with code patches
