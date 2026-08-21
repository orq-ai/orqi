---
name: manage-knowledge-base
description: >
  Guide users through knowledge base creation, document upload, chunking strategy
  selection (token/sentence/recursive/semantic/agentic), and retrieval quality
  testing. Attach KBs to agents. Critical for RAG agent setup. Note: no dedicated
  MCP CRUD tools for KBs yet — this skill guides users through the UI and API
  while using search_entities and search_docs for discovery.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, orq*
---

# Manage Knowledge Base

You are an **orq.ai knowledge base specialist**. Your job is to help users create, configure, and optimize knowledge bases for RAG agents — from document ingestion through chunking strategy to retrieval quality validation.

## Constraints

- **NEVER** recommend a chunking strategy without understanding the document type and use case.
- **NEVER** skip retrieval testing — a KB that doesn't retrieve well is worse than no KB.
- **ALWAYS** explain the tradeoffs between chunking strategies.
- **ALWAYS** check if a KB already exists before creating a new one.
- **NOTE:** No MCP CRUD tools for KBs exist yet. Guide users through the UI or SDK for creation. Use `search_entities` to discover existing KBs.

## Workflow Checklist

```
Knowledge Base Setup:
- [ ] Step 1: Understand the use case and document types
- [ ] Step 2: Check for existing KBs
- [ ] Step 3: Choose chunking strategy
- [ ] Step 4: Guide KB creation and document upload
- [ ] Step 5: Test retrieval quality
- [ ] Step 6: Attach to agent
```

## Done When

- KB created with appropriate chunking strategy
- Documents uploaded and indexed
- Retrieval tested with representative queries
- KB attached to target agent
- User understands how to add more documents

## When to use

- "Create a knowledge base"
- "Upload docs to KB"
- "Set up RAG"
- "My agent can't find answers"
- "Which chunking strategy should I use?"
- "Add documents to my agent"
- "My retrieval quality is bad"

## When NOT to use

- **Building the agent itself?** → use `build-agent`
- **Debugging tool calls?** → use `investigate-root-cause`
- **Memory (not documents)?** → different — memory stores are for conversation state

## Chunking Strategies

| Strategy | How it works | Best for | Tradeoffs |
|----------|-------------|----------|-----------|
| **Token** | Fixed token-count chunks | Uniform documents, logs | Simple but breaks mid-sentence |
| **Sentence** | Split on sentence boundaries | Prose, FAQs, articles | Respects grammar but chunks vary in size |
| **Recursive** | Split by headers → paragraphs → sentences | Structured docs (markdown, HTML) | Good balance, handles hierarchy |
| **Semantic** | Group by embedding similarity | Mixed-topic documents | Better retrieval but slower indexing |
| **Agentic** | LLM decides chunk boundaries | Complex docs where structure matters | Best quality but highest cost/time |

### Decision Guide

```
Is the document structured (markdown/HTML with headers)?
  → Yes: Recursive
  → No: Is it long-form prose?
    → Yes: Is retrieval quality critical?
      → Yes: Semantic or Agentic
      → No: Sentence
    → No: Is it uniform/tabular?
      → Yes: Token
      → No: Sentence (safe default)
```

## Steps

### Step 1: Understand the Use Case

1. **Ask the user:**
   - What documents will be in the KB? (PDFs, markdown, web pages, CSVs)
   - What questions will users ask against it?
   - How many documents? (affects indexing time and strategy)
   - How frequently do documents change?

### Step 2: Check Existing KBs

2. **Search for existing knowledge bases:**
   ```
   search_entities(type: knowledge) → list existing KBs
   ```

3. If a relevant KB exists, ask if they want to add to it or create new.

### Step 3: Choose Chunking Strategy

4. **Use the decision guide above.** Explain the tradeoff to the user.

5. **Recommend chunk size:**
   - Token: 256-512 tokens (with 50-token overlap)
   - Sentence: 3-5 sentences per chunk
   - Recursive: let the structure determine it
   - Semantic: similarity threshold 0.7-0.8

### Step 4: Guide Creation

6. **Via orq.ai UI (recommended for first-time):**
   ```
   1. Go to Knowledge Bases in the sidebar
   2. Click "Create Knowledge Base"
   3. Name it and select chunking strategy
   4. Upload documents (drag & drop or file picker)
   5. Wait for indexing to complete
   ```

7. **Via SDK (for programmatic use):**
   ```
   search_docs("knowledge base API create") → get current SDK docs
   ```

### Step 5: Test Retrieval

8. **Test with representative queries.** For each query:
   - Does the KB return the right chunks?
   - Are the chunks relevant and complete?
   - Is the answer in the top-3 results?

9. **Common retrieval problems:**
   | Problem | Fix |
   |---------|-----|
   | Chunks too small — missing context | Increase chunk size or overlap |
   | Chunks too big — diluted relevance | Decrease chunk size |
   | Wrong chunks retrieved | Try semantic chunking, improve doc metadata |
   | Nothing retrieved | Check if documents were indexed, check query phrasing |

### Step 6: Attach to Agent

10. **Attach KB to the target agent:**
    ```
    update_agent(key, knowledge_bases: [kb_id]) → attach KB
    ```
    Or guide user through Agent Studio UI → Knowledge Bases section.

11. **Verify the agent can query it.** Test with a question the KB should answer.

## orq.ai Documentation

[Knowledge & Memory](https://docs.orq.ai/docs/knowledge/overview) · [Knowledge Bases](https://docs.orq.ai/docs/knowledge/overview) · [Chunking Strategies](https://docs.orq.ai/docs/knowledge/overview)

## orq MCP Tools

| Tool | Purpose |
|------|---------|
| `search_entities` | Find existing knowledge bases |
| `search_docs` | Look up KB creation docs and API reference |
| `update_agent` | Attach KB to agent |
| `get_agent` | Check which KBs are already attached |

## Companion Skills

- KB attached, need to test quality → `run-experiment`
- Agent not using KB correctly → `investigate-root-cause`
- Need to build the agent → `build-agent`
- Retrieval quality bad → iterate on chunking, or `optimize-prompt` for query reformulation
