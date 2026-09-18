# Canvas Surface Proof

Source: fixture-input.json
Nodes: 4
Edges: 4

## Node counts

| Type | Count |
| ---- | ----- |
| plan | 1 |
| decision | 1 |
| file | 1 |
| agent_run | 1 |

## Nodes

- plan: plan-release — Verify Canvas portable artifact
- decision: decision-offline — Keep SVG standalone and disclose the HTML CDN
- file: file-export — scripts/export-canvas.mjs
- agent_run: agent-proof — Run the Canvas portable proof

## Typed edges

| Type | From node | To node |
| ---- | --------- | ------- |
| MOTIVATED_BY | plan-release | decision-offline |
| PRODUCED_BY | file-export | agent-proof |
| DECOMPOSES_INTO | plan-release | file-export |
| EXECUTED_BY | plan-release | agent-proof |
