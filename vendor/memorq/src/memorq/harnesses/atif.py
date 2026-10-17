"""Harbor's Agent Trajectory Interchange Format (ATIF): transcripts only. No model: Harbor runs many agents, and ATIF
does not say which CLI wrote it, so notes are written with Claude's."""

from __future__ import annotations

import contextlib
import json
from typing import TYPE_CHECKING, Any

from .. import transcripts

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

__all__ = ['Transcripts', 'to_steps']


def _atif_document(path: Path) -> dict[str, Any] | None:
    with contextlib.suppress(OSError, ValueError):
        doc = json.loads(path.read_text())
        if isinstance(doc, dict) and str(doc.get('schema_version', '')).startswith('ATIF'):
            return doc
    return None


def to_steps(step: dict[str, Any], *, subagent: bool) -> Iterator[transcripts.Step]:
    if step.get('is_copied_context'):  # context replayed from an earlier trajectory, not new work
        return
    text = transcripts.text_of(step.get('message'))
    if step.get('source') == 'user':
        yield transcripts.Step('user', text, subagent=subagent)
    elif step.get('source') == 'agent':
        if step.get('reasoning_content'):
            yield transcripts.Step('thinking', str(step['reasoning_content']), subagent=subagent)
        if text:
            yield transcripts.Step('text', text, subagent=subagent)
        for c in step.get('tool_calls') or []:
            args = json.dumps(c.get('arguments'), ensure_ascii=False)
            yield transcripts.Step(
                'tool_call',
                args,
                tool=c.get('function_name') or '',
                call_id=c.get('tool_call_id') or '',
                subagent=subagent,
            )
        for r in (step.get('observation') or {}).get('results') or []:
            out = transcripts.text_of(r.get('content'))
            yield transcripts.Step('tool_result', out, call_id=r.get('source_call_id') or '', subagent=subagent)


class Transcripts:
    """Harbor's Agent Trajectory Interchange Format: one JSON document per run (`<trial>/agent/trajectory.json`),
    rewritten whole, not appended. The cursor counts the top-level steps already read. ATIF results carry no error
    flag, so the projection's text match decides which failed.

    ponytail: embedded subagent trajectories are read with the first part only, after the main steps; read them by
    the `subagent_trajectory_ref` of each result if subagents (kept with ORQ_NOTES_KEEP=...,subagents) need their order.
    """

    def detect(self, path: Path) -> bool:
        return path.suffix == '.json' and _atif_document(path) is not None

    def session_id(self, path: Path) -> str:
        doc = _atif_document(path) or {}
        if sid := doc.get('session_id'):
            return str(sid)
        return path.parent.parent.name if path.parent.name == 'agent' else path.stem

    def read(self, path: Path, cursor: int) -> tuple[list[transcripts.Step], int]:
        doc = json.loads(path.read_text())  # a half-written file raises: this run fails, the next one reads it
        steps = doc.get('steps') or []
        out = [s for step in steps[cursor:] for s in to_steps(step, subagent=False)]
        if cursor == 0:
            subs = doc.get('subagent_trajectories') or []
            out += [s for sub in subs for step in sub.get('steps') or [] for s in to_steps(step, subagent=True)]
        return out, len(steps)
