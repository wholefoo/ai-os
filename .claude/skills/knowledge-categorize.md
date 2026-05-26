---
name: knowledge-categorize
description: Auto-categorize and tag sources for the Knowledge Graph
category: intelligence
agent: knowledge-graph
est: ~15s
parameters:
  - name: source_id
    type: string
    description: ID of source to categorize (or 'all' for batch)
  - name: force
    type: boolean
    description: Re-categorize even if already tagged
    default: false
---

# Knowledge Categorize

Analyzes source content and assigns:
- **Type**: wiki, docs, research, outputs, raw
- **Tags**: Semantic labels based on content analysis
- **Connections**: Links to related nodes in the graph

Processes all uncategorized sources when source_id is 'all'.
