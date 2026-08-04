# Execution — how work is launched and checked

Read when: touching how a skill or pipeline runs, or how output gets verified.

## How We Work
1. **Intake**: Structured interview to capture requirements.
2. **Decomposition**: Break requirements into capabilities and roles.
3. **Team Design**: Select agents from the role library.
4. **Materialization**: Factory generates sub-agent files.
5. **Orchestration**: Dispatch, collect, review, report.

## Verification Protocols (Plan-Execute-Verify)
Automated quality gates that validate agent outputs against configurable rubrics before delivery:
- **Rubric Library**: YAML-defined rubrics for 6 categories (default, research, marketing, security, sales, design)
- **Weighted scoring**: Each check has a weight (1-3), aggregate score determines verdict (PASS >= 80, REVIEW 60-79, FAIL < 60)
- **Inheritance**: Category rubrics inherit default checks plus add category-specific ones
- **Human override**: REVIEW verdicts route to operator for manual approve/reject
- **Execution integration**: Verifications can link to skill executions for end-to-end traceability
- **Dashboard view**: Score gauges, per-check results grid, category pass rates, rubric detail modals

> P2 re-keyed verification from these 6 generic buckets to each agent's OWN criteria, and P5 added
> `stakes` (probe|standard|critical) to set depth. The rubric library is the floor, not the whole
> standard — see `.magent/vault/wiki/agent-handbooks-design.md`.

## One-Click Skill Execution (Skill Launchpad)
Dashboard-integrated skill execution system that turns complex workflows into clickable buttons:
- **Parameter auto-parsing**: Extracts parameters, steps, and agent assignments from skill markdown files
- **Smart forms**: Generates input forms with dropdowns, number fields, toggles, and text inputs based on skill definitions
- **Category filtering**: Filter skills by research, marketing, sales, security, design, intelligence
- **Search**: Full-text search across skill names and descriptions
- **Execution tracking**: Real-time progress bars with step-by-step dot indicators and WebSocket updates
- **Parameter display**: Shows configured parameters as tags on completed executions
- **Dashboard integration**: Quick Actions on the main dashboard launch the same parameter-aware modals

## Skill Chaining (Pipeline Engine)
Declarative YAML pipelines that chain skills and agents into multi-step workflows:
- **Pipeline definitions** in `.claude/pipelines/*.yaml` — stages, dependencies, gates, parameters
- **Available pipelines**: research-to-report (5 stages), content-pipeline (4 stages), security-sweep (4 stages)
- **Gate system**: Stages with `gate: blocking` or `gate: advisory` pause for human approval
- **Cost tracking**: Each pipeline stage logs token usage to the cost ledger automatically
