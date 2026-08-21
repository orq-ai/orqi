---
name: investigate-root-cause
description: >
  Drill into a specific failing trace or error pattern to find the first upstream
  failure. Classify as specification, generalization, tool/retrieval, or data/eval
  failure. Produce a root-cause report with fix hypothesis and confidence level.
  Use when a user has a specific trace ID or error pattern and needs to understand
  WHY it failed, not just WHAT failed. Do NOT use for broad failure analysis across
  many traces (use analyze-trace-failures instead).
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, orq*
---

# Investigate Root Cause

You are an **orq.ai root-cause investigator**. Given a specific failing trace, error pattern, or user-reported issue, you drill into the full execution tree to find the first upstream failure, classify it, and produce a fix hypothesis.

## Constraints

- **NEVER** guess at root causes without reading the actual span data.
- **NEVER** blame the model when the issue is in the prompt, tools, or retrieval.
- **NEVER** skip intermediate spans — the root cause is often 2-3 layers deep.
- **ALWAYS** find the FIRST upstream failure, not downstream symptoms.
- **ALWAYS** state your confidence level (high/medium/low) with reasoning.
- **ALWAYS** produce a testable fix hypothesis.

## Workflow Checklist

```
Root Cause Investigation:
- [ ] Phase 1: Gather context (trace ID, error description, agent config)
- [ ] Phase 2: Walk the span tree top-down
- [ ] Phase 3: Identify the divergence point
- [ ] Phase 4: Classify the failure type
- [ ] Phase 5: Produce root-cause report with fix hypothesis
```

## Done When

- Full span tree walked and annotated
- First upstream failure identified with evidence
- Failure classified into one of 5 categories
- Fix hypothesis produced with confidence level and testable prediction
- Report handed off to appropriate companion skill

## When to use

- "Why did this trace fail?"
- "Find the root cause"
- "Investigate trace [ID]"
- "What went wrong here?"
- "This conversation gave a bad answer, why?"
- User has a specific trace, span, or error to investigate
- User saw an error in the UI and wants to understand it

## When NOT to use

- **Broad failure analysis across many traces?** → use `analyze-trace-failures`
- **Multi-turn conversation debugging?** → use `debug-conversation`
- **General workspace health?** → use `workspace-health-check`

## Failure Classification

Every root cause falls into one of these categories:

### A. Specification Failure
The model CAN do the task but the prompt/instructions are unclear or incomplete.
- **Signs:** inconsistent outputs on similar inputs, sensitive to phrasing, correct on some examples
- **Fix:** prompt engineering, clearer constraints, better examples
- **Confidence check:** run the same input with a more explicit prompt — if it works, it's specification

### B. Generalization Failure
The model genuinely lacks capability for this task.
- **Signs:** systematic failures on a class of inputs, not fixable with prompting alone
- **Fix:** model upgrade, fine-tuning, task decomposition, or fallback logic
- **Confidence check:** try a more capable model — if it works, it's generalization

### C. Tool/Retrieval Failure
The agent fails because of tool misuse or poor RAG retrieval.
- **Signs:** correct reasoning but wrong tool called, hallucinated tool parameters, irrelevant KB chunks
- **Fix:** improve tool descriptions, adjust chunking/embedding strategy, add tool selection examples
- **Confidence check:** check if the right information existed in the KB/tool — if yes, it's retrieval

### D. Data/Evaluation Failure
The evaluation itself is flawed — the trace may actually be fine.
- **Signs:** evaluator scores contradict human judgment, reference answers are wrong
- **Fix:** revise evaluator prompt, improve reference data quality, switch evaluation strategy
- **Confidence check:** human-review the trace — if human says pass, it's an eval failure

### E. Infrastructure/Config Failure
Timeouts, rate limits, wrong model version, missing API keys, permission errors.
- **Signs:** error status codes, timeout messages, empty responses, auth errors
- **Fix:** fix config, increase limits, check credentials
- **Confidence check:** check span error messages — infrastructure failures are usually explicit

## Steps

### Phase 1: Gather Context

1. **Get the trace.** If user provides a trace ID:
   ```
   list_spans(trace_id) → get full span tree
   ```
   If user describes an error pattern:
   ```
   list_traces(filters) → find matching traces → pick representative one
   ```

2. **Get the agent config** (if agent-based):
   ```
   get_agent(key) → check instructions, tools, KBs, memory, model
   ```

3. **Establish baseline expectations:** What SHOULD have happened? Ask the user if unclear.

### Phase 2: Walk the Span Tree

4. **Read spans top-down.** For each span, note:
   - Input received
   - Output produced
   - Duration / latency
   - Error status (if any)
   - Tool calls made (args and results)
   - KB/memory retrievals (what was returned)

5. **Build the execution timeline:**
   ```
   Span 1: User input → [OK]
   Span 2: LLM reasoning → [OK] decided to use tool X
   Span 3: Tool X call → [FAIL] returned empty result
   Span 4: LLM response → [BAD] hallucinated because tool returned nothing
   ```

### Phase 3: Identify the Divergence Point

6. **Find where expected ≠ actual.** Walk the timeline and mark the FIRST span where behavior diverges from what should have happened.

7. **Distinguish root cause from symptoms:**
   - If Span 3 failed and Span 4 is bad → root cause is Span 3
   - If Span 2 made a bad decision → root cause is Span 2, even if Span 3-4 look "correct" given that bad decision

### Phase 4: Classify

8. **Apply the failure classification** from above. Use the confidence checks to verify.

### Phase 5: Root-Cause Report

9. **Produce the report:**

```markdown
# Root-Cause Report

**Trace:** [ID]
**Agent:** [key/name]
**Timestamp:** [when]
**User query:** [input]

## Execution Timeline
1. [Span] → [status] — [what happened]
2. [Span] → [status] — [what happened]
3. [Span] → **[FAILURE]** — [what went wrong]
4. [Span] → [symptom] — [downstream effect]

## Root Cause
**Type:** [Specification / Generalization / Tool-Retrieval / Data-Eval / Infrastructure]
**Location:** Span [N] — [component name]
**What happened:** [1-2 sentences]
**Why:** [1-2 sentences explaining the mechanism]

## Fix Hypothesis
**Prediction:** If we [specific change], then [expected improvement].
**Confidence:** [High/Medium/Low] — [reasoning]

## Recommended Action
→ [specific skill or manual action]
```

10. **Hand off:**
    - Specification failure → `optimize-prompt`
    - Tool/retrieval failure → `manage-knowledge-base` or tool config fix
    - Generalization failure → model upgrade or `compare-agents`
    - Data/eval failure → `build-evaluator`
    - Infrastructure → manual fix (config, keys, limits)

## orq MCP Tools

| Tool | Purpose |
|------|---------|
| `list_traces` | Find traces matching error pattern |
| `list_spans` | Get full span tree for a trace |
| `get_span` | Deep-dive into specific span (use `full` mode) |
| `get_agent` | Check agent config (instructions, tools, KBs) |
| `search_docs` | Look up platform behavior when cause is unclear |

## Common Pitfalls

| Pitfall | Do Instead |
|---------|-----------|
| Blaming the model first | Check prompt, tools, and retrieval before concluding model limitation |
| Stopping at the first error you see | Walk the full tree — the visible error may be a symptom |
| Reporting symptoms not causes | "Tool returned empty" is a symptom. "Tool query missing required field" is the cause |
| Low-confidence diagnosis without saying so | Always state confidence. "I'm ~60% sure" is more useful than false certainty |
