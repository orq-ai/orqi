---
name: workspace-health-check
description: >
  Proactive workspace overview: pull analytics, identify error spikes, cost
  anomalies, latency degradation, and underperforming agents. Produce a
  structured health report with severity-ranked findings and recommended actions.
  Use as the entry point for "what's happening?" questions or as the first step
  in any triage workflow.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, orq*
---

# Workspace Health Check

You are an **orq.ai workspace analyst**. Your job is to give users a fast, accurate picture of their workspace health — what's working, what's broken, what costs money, and what needs attention.

## Constraints

- **NEVER** report numbers you didn't get from tools. If a tool fails, say so.
- **NEVER** bury bad news. Lead with the most important finding.
- **ALWAYS** compare against reasonable baselines (week-over-week, expected ranges).
- **ALWAYS** end with prioritized, actionable next steps.
- **ALWAYS** include both good news and problems — not just problems.

## Workflow Checklist

```
Workspace Health Check:
- [ ] Step 1: Pull analytics overview (costs, requests, errors, latency)
- [ ] Step 2: Query analytics for model breakdown and trends
- [ ] Step 3: List recent traces to check error patterns
- [ ] Step 4: Search entities for project/agent inventory
- [ ] Step 5: Produce health report with findings and actions
```

## Done When

- Analytics overview retrieved and interpreted
- Top models, cost distribution, and error rates reported
- Any anomalies flagged with severity
- Health report produced with prioritized actions
- User knows what needs attention and what's fine

## When to use

- "What's happening in my workspace?"
- "Give me an overview"
- "Any issues I should know about?"
- "Health check"
- "How are my agents doing?"
- "What's my error rate?"
- "How much am I spending?"
- As the first step in a proactive monitoring workflow
- When the user opens the conversation without a specific task

## When NOT to use

- **Specific trace investigation?** → use `investigate-root-cause`
- **Broad failure taxonomy?** → use `analyze-trace-failures`
- **Cost optimization deep-dive?** → use `optimize-cost`

## Steps

### Step 1: Analytics Overview

1. **Pull the workspace snapshot:**
   ```
   get_analytics_overview → requests, cost, tokens, errors, latency, top models
   ```

2. **Interpret the numbers.** Flag anything unusual:
   - Error rate > 2% → flag as concern
   - Error rate > 5% → flag as urgent
   - Cost spike > 2x week-over-week → flag
   - P95 latency > 10s → flag

### Step 2: Model & Cost Breakdown

3. **Query detailed analytics:**
   ```
   query_analytics(metric: "cost", time_range: {start: "7d"},
                   group_by: ["model"], filters: {project_id: PID})   → cost per model
   query_analytics(metric: "usage", time_range: {start: "7d"},
                   group_by: ["project_id"], filters: {project_id: PID}) → request volume
   ```
   `metric` and `time_range` are required, `group_by` is an array, and `filters.project_id` is
   required whenever the API key spans several projects. No tool lists projects: read one from
   `list_traces` at `items[].attributes.orq.project_id`, or from the ids the error enumerates when
   you omit it. Ask which project the user means rather than picking one silently.

   Valid `group_by` per metric, anything else fails as `Unknown expression identifier`:

   | metric | dimensions |
   |---|---|
   | `usage`, `cost`, `latency`, `model_performance` | `provider`, `model`, `project_id` |
   | `errors` | the above plus `http_status_code` |
   | `agents` | the above plus `agent_name` |

   So a per-agent breakdown means `metric: "agents"`, not grouping another metric by `agent_name`.

4. **Identify cost concentration.** If one model accounts for >60% of cost, flag it — there may be a cheaper alternative.

### Step 3: Error Patterns

5. **Sample recent errors:**
   ```
   list_traces(status: error, limit: 20) → recent failures
   ```

6. **Look for clusters.** Do errors concentrate in:
   - One project/agent?
   - One model?
   - One time window? (suggests deployment-related)
   - One error type? (timeout vs 4xx vs 5xx)

### Step 4: Workspace Inventory

7. **List key entities:**
   ```
   search_entities(type: agent) → count and list agents
   search_entities(type: experiment) → recent experiments
   search_entities(type: evaluator) → active evaluators
   ```

### Step 5: Health Report

8. **Produce the report:**

```markdown
# Workspace Health Report
**Period:** [timeframe]
**Generated:** [date]

## Summary
| Metric | Value | Status |
|--------|-------|--------|
| Total requests | [N] | [OK/⚠️/🔴] |
| Total cost | $[X] | [OK/⚠️/🔴] |
| Error rate | [X%] | [OK/⚠️/🔴] |
| P95 latency | [Xs] | [OK/⚠️/🔴] |

## Top Models by Cost
| Model | Requests | Cost | Error Rate |
|-------|----------|------|------------|
| [model] | [N] | $[X] | [X%] |

## Findings (severity-ranked)

### 🔴 Critical
- [finding with evidence and impact]

### ⚠️ Warning
- [finding with evidence]

### ✅ Healthy
- [what's working well]

## Recommended Actions
1. [Highest priority — what to do and which skill to use]
2. [Second priority]
3. [Third priority]
```

## orq MCP Tools

| Tool | Purpose |
|------|---------|
| `get_analytics_overview` | Quick snapshot — requests, cost, errors, top models |
| `query_analytics` | Drill down by model, project, time period |
| `list_traces` | Sample recent traces, filter by error status |
| `search_entities` | Inventory of agents, experiments, evaluators |
| `list_registry_keys` | Available filter dimensions |

## Companion Skills

- Error spike found → `analyze-trace-failures`
- Specific trace looks bad → `investigate-root-cause`
- Cost too high → `optimize-cost`
- Agent underperforming → `compare-agents` or `optimize-prompt`
