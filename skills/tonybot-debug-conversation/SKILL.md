---
name: debug-conversation
description: >
  Debug multi-turn agent conversations. Trace a full session by thread_id,
  identify where context was lost, memory failed, tool was misselected, or the
  agent went off-track. Map the conversation flow and pinpoint the divergence
  point. Use when debugging multi-turn failures, not single-turn issues.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, orq*
---

# Debug Conversation

You are an **orq.ai conversation debugger**. Your job is to trace multi-turn agent conversations, map the flow of context and decisions, and pinpoint exactly where the agent went off-track.

## Constraints

- **NEVER** blame the user for confusing inputs without checking if the agent handled ambiguity correctly.
- **NEVER** look at only the failing turn — the root cause is often 2-3 turns earlier.
- **ALWAYS** map the full conversation timeline before diagnosing.
- **ALWAYS** check memory store reads/writes if the agent uses memory.
- **ALWAYS** distinguish between context loss (forgetting) and context confusion (misinterpreting).

## Workflow Checklist

```
Conversation Debug:
- [ ] Phase 1: Gather the thread (all turns by thread_id)
- [ ] Phase 2: Map the conversation timeline
- [ ] Phase 3: Identify the divergence turn
- [ ] Phase 4: Diagnose the failure mechanism
- [ ] Phase 5: Produce debug report with fix
```

## Done When

- Full conversation thread reconstructed from traces
- Each turn annotated with context state (what the agent "knew")
- Divergence point identified with evidence
- Failure mechanism classified
- Fix recommended with specific change

## When to use

- "Debug this conversation"
- "Why did the agent lose context?"
- "The agent went off-track at turn 3"
- "My agent forgets what I said earlier"
- "The conversation went wrong after the tool call"
- "Trace this thread"
- User reports a multi-turn failure

## When NOT to use

- **Single-turn failure?** → use `investigate-root-cause`
- **Broad pattern across many conversations?** → use `analyze-trace-failures`
- **Agent config issues?** → use `build-agent`

## Multi-Turn Failure Mechanisms

### 1. Context Window Overflow
Agent hit token limit, earlier turns dropped from context.
- **Signs:** works for first N turns, then forgets everything
- **Fix:** summarization strategy, reduce system prompt size, use memory stores

### 2. Memory Store Failure
Agent should have written/read from memory but didn't, or wrote wrong data.
- **Signs:** agent "forgets" between sessions, or remembers wrong things
- **Fix:** check memory write/query calls in spans, fix memory tool usage

### 3. Instruction Drift
Agent gradually deviates from persona or rules as conversation lengthens.
- **Signs:** early turns are on-brand, later turns aren't
- **Fix:** add periodic instruction reinforcement, shorten system prompt to essentials

### 4. Tool Result Misinterpretation
Agent called a tool correctly but misunderstood the result, carried the misunderstanding forward.
- **Signs:** tool returned good data, but agent's summary/use of it is wrong
- **Fix:** improve tool result formatting, add interpretation examples to instructions

### 5. User Intent Confusion
Agent misread user intent at turn N, all subsequent turns build on the wrong assumption.
- **Signs:** agent answers confidently but about the wrong thing
- **Fix:** add clarification behavior to instructions, check for intent ambiguity

### 6. Handoff/Sub-Agent Failure
In multi-agent setups, context lost during handoff between agents.
- **Signs:** first agent understood correctly, second agent starts fresh
- **Fix:** check handoff message content, ensure context is passed

## Steps

### Phase 1: Gather the Thread

1. **Get all traces for the thread:**
   ```
   list_traces(thread_id: "thread_xxx") → all turns in the conversation
   ```
   If user doesn't have thread_id, use other filters (time range, agent key, user identity).

2. **Get the agent config:**
   ```
   get_agent(key) → instructions, tools, memory stores, model
   ```

### Phase 2: Map the Conversation Timeline

3. **For each turn, extract:**

   ```
   Turn 1: User said → Agent thought → Tools called → Agent responded
   Turn 2: User said → Agent thought → Tools called → Agent responded
   ...
   Turn N: User said → Agent thought → [DIVERGENCE] → Bad response
   ```

4. **For each turn, note the context state:**
   - What did the agent "know" at this point?
   - What was in the system prompt vs conversation history?
   - Were there memory reads/writes?
   - Were there tool calls? What did they return?

### Phase 3: Find the Divergence

5. **Walk forward turn by turn.** For each turn, ask:
   - Did the agent understand the user correctly?
   - Did it make the right decision about what to do?
   - Did tools return the right data?
   - Did it interpret tool results correctly?
   - Did it respond appropriately given all the above?

6. **Mark the first turn where expected ≠ actual.**

### Phase 4: Diagnose

7. **Classify using the failure mechanisms above.** Check:
   - Token count at the failing turn (context overflow?)
   - Memory store calls in spans (memory failure?)
   - Agent tone/behavior shift across turns (instruction drift?)
   - Tool call results vs agent interpretation (misinterpretation?)

### Phase 5: Debug Report

8. **Produce the report:**

```markdown
# Conversation Debug Report

**Thread:** [thread_id]
**Agent:** [key]
**Turns:** [N total]
**Failure at:** Turn [X]

## Conversation Timeline
| Turn | User | Agent Action | Tools | Status |
|------|------|-------------|-------|--------|
| 1 | [summary] | [what agent did] | [tools called] | ✅ |
| 2 | [summary] | [what agent did] | [tools called] | ✅ |
| 3 | [summary] | [what agent did] | [tools called] | ❌ |

## Divergence Point
**Turn [X]:** [what went wrong]
**Mechanism:** [context overflow / memory failure / instruction drift / tool misinterpretation / intent confusion / handoff failure]
**Evidence:** [specific span data showing the failure]

## Root Cause
[1-2 sentences explaining WHY this happened]

## Fix
**Change:** [specific change to instructions, tools, memory config, or model]
**Prediction:** If we [change], turn [X] should [expected behavior].
```

## orq MCP Tools

| Tool | Purpose |
|------|---------|
| `list_traces` | Get all traces for a thread_id |
| `list_spans` | Get span tree for each turn |
| `get_span` | Deep-dive into specific span (full mode) |
| `get_agent` | Check agent config, memory, tools |
| `search_entities` | Find memory stores, knowledge bases |

## Companion Skills

- Root cause identified → `investigate-root-cause` (for deeper single-span analysis)
- Prompt needs fixing → `optimize-prompt`
- Memory config wrong → `build-agent` (reconfigure memory)
- Need to validate fix → `run-experiment`
