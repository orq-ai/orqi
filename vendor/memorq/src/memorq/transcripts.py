"""Session transcripts as neutral steps, and the projection of a session part that the note writer reads.

Each harness (memorq/harnesses) reads its files into `Step`s. Nothing after this module knows which agent wrote a
session.
"""

from __future__ import annotations

import collections
import contextlib
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from . import settings

if TYPE_CHECKING:
    from collections.abc import Collection, Sequence
    from pathlib import Path

__all__ = [
    'REMINDER',
    'SECRETS',
    'Step',
    'failed_reads',
    'project',
    'read_events',
    'redact',
    'text_of',
    'tool_call_inputs',
]

SECRETS = [
    re.compile(p)
    for p in (
        r'sk-[A-Za-z0-9_.\-]{16,}',
        r'gh[pousr]_[A-Za-z0-9]{20,}',
        r'github_pat_[A-Za-z0-9_]{20,}',
        r'AKIA[0-9A-Z]{16}',
        r'xox[abpr]-[A-Za-z0-9\-]{10,}',
        r'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*',
        r'(?i)bearer\s+[A-Za-z0-9._~+/\-]{8,}=*',
        r'(?i)\b\w*(?:api_?key|token|secret|password)\w*["\']?\s*[=:]\s*["\']?[^\s"\'&]{6,}',
        r'\b[A-Fa-f0-9]{32,}\b',
        r'\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{40,}\b',
    )
]
REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.DOTALL)


def redact(text: str) -> str:
    for pattern in SECRETS:
        text = pattern.sub('[REDACTED]', text)
    return text


def text_of(content: Any) -> str:
    """The text of a message's content: a string, or the text blocks of a list of blocks."""
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if isinstance(b, dict) and b.get('type') == 'text')


def read_events(path: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    """Transcript lines from a byte offset up to the last complete line. Returns (events, new offset)."""
    data = path.read_bytes()
    end = data.rfind(b'\n') + 1
    events = []
    for line in data[offset:end].splitlines():
        with contextlib.suppress(ValueError):
            events.append(json.loads(line))
    return events, max(end, offset)


@dataclass(frozen=True)
class Step:
    """One thing that happened in a session, whichever agent wrote it."""

    kind: str  # 'user', 'text' (assistant text), 'thinking', 'tool_call', 'tool_result'
    text: str  # the message, the tool input as JSON, or the tool output
    tool: str = ''  # tool_call: the tool's name
    call_id: str = ''  # pairs a tool_result with its tool_call, when the format has ids
    error: bool | None = None  # tool_result: the format's own error flag; None when it has none
    subagent: bool = False  # a subagent's step (a Claude Code sidechain, an ATIF subagent trajectory)


def _looks_failed(step: Step) -> bool:
    """A tool result that failed: the format says so, or its text mentions an error or a failure."""
    low = step.text.lower()
    return bool(step.error) or 'error' in low or 'fail' in low


def project(
    steps: Sequence[Step],
    keep: Collection[str] | None = None,
    max_chars: int | None = None,
    max_items: int | None = None,
) -> dict[str, Any]:
    """What the note writer reads of a session part: the kinds of step `keep` names, each cut to `max_chars`, at most
    `max_items` (the first third and the last two thirds). Defaults: settings.KEEP, MAX_CHARS and MAX_ITEMS.
    """
    keep = settings.KEEP if keep is None else frozenset(keep)
    max_chars = settings.MAX_CHARS if max_chars is None else max_chars
    max_items = settings.MAX_ITEMS if max_items is None else max_items
    items: list[dict[str, Any]] = []
    for s in steps:
        if s.subagent and 'subagents' not in keep:
            continue
        if s.kind == 'user':
            if 'user' in keep and (text := REMINDER.sub('', s.text).strip()):
                items.append({'user': text[:max_chars]})
        elif s.kind == 'tool_call':
            if 'tools' in keep:
                items.append({'tool': s.tool, 'input': s.text[:max_chars]})
        elif s.kind == 'tool_result':
            if _looks_failed(s) and keep & {'errors', 'results'}:
                items.append({'tool_result_error': s.text[:max_chars]})
            elif 'results' in keep:
                items.append({'tool_result': s.text[:max_chars]})
        elif s.kind in keep and s.text:  # 'text', 'thinking'
            items.append({s.kind: s.text[:max_chars]})
    first_user = next((i['user'] for i in items if 'user' in i), '')
    if len(items) > max_items:  # keep the start and the end, as knowledge notes v2 did in the benchmark
        head = max_items // 3
        items = [*items[:head], {'omitted_events': len(items) - max_items}, *items[len(items) - (max_items - head) :]]
    return {'first_user_message': first_user[:3000], 'events': items}


def tool_call_inputs(steps: Sequence[Step]) -> list[str]:
    """The input of every tool call the main agent made, as JSON."""
    return [s.text for s in steps if s.kind == 'tool_call' and not s.subagent]


def failed_reads(steps: Sequence[Step], notes_dir: Path) -> int:
    """Failed reads of notes: tool results that are errors, for calls that named a `.md` file under notes_dir.

    A call names a note when its input contains `<notes_dir>/<file>.md`. Results pair with calls by position: a FIFO
    holds one flag per tool call and each tool result pops the front (False when empty), so parallel calls in one
    message pair in order. An error is the format's flag when it has one; the "no such file" / "enoent" text match
    only applies to results without it.

    ponytail: positional FIFO. The ceiling is results returned out of call order, which mis-pairs; pair by
    `call_id` when every format in use has ids.
    """
    note = re.compile(re.escape(str(notes_dir)) + r'/[^"\s]+\.md')
    pending: collections.deque[bool] = collections.deque()
    failed = 0
    for s in steps:
        if s.subagent:
            continue
        if s.kind == 'tool_call':
            pending.append(bool(note.search(s.text)))
        elif s.kind == 'tool_result':
            if not (pending.popleft() if pending else False):
                continue
            error = s.error
            if error is None:
                low = s.text.lower()
                error = 'no such file' in low or 'enoent' in low
            failed += bool(error)
    return failed
