"""Memory, the interface the hooks use: `write` after a session, `retrieve` before one, `maintain` at session start.

NotesMemory is knowledge notes. Another strategy or library plugs in as a class with the same three methods, named
with ORQ_NOTES_MEMORY=package.module:factory, where factory(root) returns it; `root` holds one folder per repository.
Consolidation (consolidate.py) reads transcripts into Sessions, holds the store lock, keeps the cursors and logs what
`write` returns, so a memory only learns and recalls.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from . import dream, extensions, harnesses, index, llm, records, retrieval, settings, transcripts
from . import store as notes_store  # as everywhere in memorq: a local named `store` would hide the module

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

__all__ = ['MEMORIES', 'Memory', 'NotesMemory', 'Session', 'make_memory', 'propose']


@dataclass(frozen=True)
class Session:
    """A session part to learn from, read into steps."""

    key: str  # the repository's store key
    session_id: str
    harness: str  # the harness's name: 'claude', 'pi', 'atif', or an outside one
    steps: list[transcripts.Step]  # the part not written yet
    history: list[transcripts.Step]  # the whole session so far, this part included
    cwd: str | None = None  # the hook's working directory, when one asked: its repository may hold the notes


class Memory(Protocol):
    def write(self, session: Session) -> dict[str, Any]:
        """Learn from a session part. Returns what to log; {'skipped': reason} offers the part again with the next one."""
        ...

    def retrieve(self, key: str, query: str | None, cwd: str | None = None) -> str:
        """Text for the agent's context: for a task (`query`), or at session start (None). '' when there is none. `cwd`,
        the hook's working directory, is optional: the hooks pass it only to a memory whose `retrieve` takes it."""
        ...

    def maintain(self, key: str, cwd: str) -> None:
        """Upkeep at session start, never in read-only mode: start slow work in the background, or do nothing."""
        ...


def propose(
    record: dict[str, Any],
    steps: list[transcripts.Step],
    existing: list[tuple[str, dict[str, str]]],
    *,
    harness: str,
    model: Callable[..., tuple[dict[str, Any], dict[str, Any]]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Consolidate then review one transcript part. Adds candidates and usage to `record`."""
    proj = transcripts.redact(json.dumps(transcripts.project(steps)))
    prompt = (settings.PROMPTS / 'consolidate-live.md').read_text().replace('{source}', record['session'])
    data, record['consolidate_usage'] = (model or llm.llm_json)(prompt, proj, harness=harness)
    candidates = [n for n in data.get('notes', []) if n.get('title') and n.get('trigger') and n.get('body')]
    candidates = [{k: transcripts.redact(v) if isinstance(v, str) else v for k, v in n.items()} for n in candidates]
    record['candidates'] = candidates
    if not candidates:
        return candidates, []
    review_input = {'existing_notes': [n for _, n in existing], 'candidates': candidates}
    review = (settings.PROMPTS / 'review-live.md').read_text()
    reviewer = harnesses.reviewer(harness)
    data, record['review_usage'] = (model or llm.llm_json)(review, json.dumps(review_input), harness=reviewer)
    return candidates, data.get('decisions', [])


class NotesMemory:
    """Knowledge notes: a writer and a reviewer model call turn a session part into notes; the index and a retriever
    read them back; the dream folds them into rules and skills. `rank` and `model` default to ORQ_NOTES_RANK and the
    model CLI of the session's harness.
    """

    def __init__(self, root: Path, rank: str | None = None, model: Callable[..., Any] | None = None) -> None:
        self.root, self.rank, self.model = root, rank, model

    def write(self, session: Session) -> dict[str, Any]:
        store_dir, cwd = self.root / session.key, session.cwd
        # every note and rule in both roots: a candidate may restate one, and a read of one counts
        existing = notes_store.load_all(store_dir, cwd)
        reads = notes_store.dirs(store_dir, cwd, 'notes').reads
        inputs = transcripts.tool_call_inputs(session.steps)
        record: dict[str, Any] = {
            'session': session.session_id,
            'read_notes': sorted({name for name, _ in existing for i in inputs if name in i}),
            'failed_reads': sum(transcripts.failed_reads(session.steps, d) for d in reads),
        }
        # The whole session decides, not the new part: a short correction after a resume must not be dropped.
        if len(transcripts.tool_call_inputs(session.history)) < settings.MIN_TOOL_CALLS:
            return {**record, 'skipped': 'few_tool_calls'}
        try:
            candidates, decisions = propose(record, session.steps, existing, harness=session.harness, model=self.model)
        except (RuntimeError, OSError) as e:
            # Bad model key, no JSON, missing CLI: log it and advance the cursor, so the sweep does not pay again.
            record['error'], candidates, decisions = str(e)[:500], [], []
        record['decisions'], record['written'], record['superseded'] = decisions, [], []
        notes = notes_store.write_dir(store_dir, cwd, 'notes')  # after the model calls: the repo folder may be gone
        for d, candidate in records.valid_decisions(decisions, candidates):
            if d.get('decision') != 'accept':
                continue
            name = notes_store.note_filename(candidate)
            (notes / name).write_text(notes_store.render_note(candidate, session.session_id))
            record['written'].append(name)
            j = d.get('supersedes')
            # every copy, in rules/ or either root: a shadowed one left behind would come back in its place
            found = (
                notes_store.copies(store_dir, existing[j][0], cwd)
                if isinstance(j, int) and 0 <= j < len(existing)
                else []
            )
            if found and found[0].name != name:  # same name: the new note already overwrote it
                kept = notes_store.set_aside(store_dir, found)
                record['superseded'].append(found[0].name)
                if kept:
                    record.setdefault('kept_human_edited', []).append(found[0].name)
        if record['written'] and (retriever := retrieval.configured_retriever(store_dir, self.rank)):
            try:  # here, not in a hook: embedding a store takes seconds
                retriever.refresh(notes_store.read_notes(store_dir, cwd))
            except Exception as e:  # the notes are written: the part must still be logged and its cursor moved
                print(f'✗ refresh of the {self.rank or settings.RANK} retriever failed: {e}', file=sys.stderr)
        return record

    def retrieve(self, key: str, query: str | None, cwd: str | None = None) -> str:
        """The index at session start, ranked notes for a task: from the store and `cwd`'s repository folder."""
        store_dir = self.root / key
        return index.index(store_dir, cwd)[0] if query is None else retrieval.ranked(store_dir, query, self.rank, cwd)

    def maintain(self, key: str, cwd: str) -> None:
        dream.maybe_dream(self.root / key, key, cwd)


MEMORIES: dict[str, Callable[[Path], Memory]] = {'notes': NotesMemory}


def make_memory(root: Path | None = None) -> Memory:
    """The memory ORQ_NOTES_MEMORY names, for the stores under `root` (default ORQ_NOTES_HOME)."""
    return extensions.resolve(settings.MEMORY, MEMORIES)(settings.ROOT if root is None else root)
