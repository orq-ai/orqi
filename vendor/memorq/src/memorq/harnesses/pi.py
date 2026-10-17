"""Pi (and omp): transcripts are JSON lines with a session header, converted to Claude Code's shape, then to steps;
notes are written with `pi -p`."""

from __future__ import annotations

import contextlib
import json
import shutil
from typing import TYPE_CHECKING, Any

from .. import settings, transcripts
from . import claude_code

if TYPE_CHECKING:
    import subprocess
    from pathlib import Path

__all__ = ['EVENTS', 'Model', 'Transcripts', 'from_pi', 'is_pi', 'to_steps']

# Pi's extension events, as neutral events. integrations/pi/memorq.ts sends the neutral names itself; these let a
# harness forward Pi's own names. `checkpoint`, `ship` and `idle` are conditions the extension checks, not Pi events.
EVENTS = {
    'session_start': 'session_start',
    'before_agent_start': 'prompt',
    'session_before_compact': 'compact',
    'session_shutdown': 'session_end',
}


def _type(entry: Any) -> Any:  # a line that is not an object (a JSON array, say) has no type
    return entry.get('type') if isinstance(entry, dict) else None


def is_pi(path: Path) -> bool:
    """Pi session files have a {"type": "session"} header on line 1 (omp: line 2, after a "title" line)."""
    with path.open() as f, contextlib.suppress(ValueError):
        return any(_type(json.loads(f.readline() or '{}')) == 'session' for _ in range(2))
    return False


def from_pi(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pi session entries in the Claude Code shape that claude_code.to_steps reads.

    ponytail: file order, so branches abandoned with /tree are kept; follow parentId from the leaf if they pollute notes.
    """
    events: list[dict[str, Any]] = []
    for e in entries:
        m = e.get('message') or {}
        if e.get('type') != 'message':
            continue
        if m.get('role') == 'user':
            events.append({'type': 'user', 'message': {'content': m.get('content')}})
        elif m.get('role') == 'assistant':
            blocks = [
                {'type': 'tool_use', 'id': b.get('id'), 'name': b.get('name'), 'input': b.get('arguments')}
                if b['type'] == 'toolCall'
                else b
                for b in m.get('content') or []
                if isinstance(b, dict) and b.get('type') in {'text', 'thinking', 'toolCall'}
            ]
            events.append({'type': 'assistant', 'message': {'content': blocks}})
        elif m.get('role') == 'toolResult':
            result = {
                'type': 'tool_result',
                'tool_use_id': m.get('toolCallId'),
                'content': transcripts.text_of(m.get('content')),
                'is_error': m.get('isError'),
            }
            events.append({'type': 'user', 'message': {'content': [result]}})
        elif m.get('role') == 'bashExecution' and not m.get('excludeFromContext'):
            text = f'[user ran in shell] $ {m.get("command")}\n{(m.get("output") or "")[-400:]}'
            events.append({'type': 'user', 'message': {'content': text}})
    return events


def to_steps(entries: list[dict[str, Any]]) -> list[transcripts.Step]:
    """Pi session entries as steps."""
    return claude_code.to_steps(from_pi(entries))


class Transcripts:
    def detect(self, path: Path) -> bool:
        return is_pi(path)

    def session_id(self, path: Path) -> str:
        return path.stem

    def read(self, path: Path, cursor: int) -> tuple[list[transcripts.Step], int]:
        entries, end = transcripts.read_events(path, cursor)
        return to_steps(entries), end


class Model:
    def available(self) -> bool:
        return shutil.which('pi') is not None

    def command(self, system: str) -> list[str]:
        cmd = ['pi', '-p', '--mode', 'json', '--system-prompt', system, '--no-session', '--no-tools']
        cmd += ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']
        return cmd + (['--model', settings.PI_MODEL] if settings.PI_MODEL else [])

    def parse(self, stdout: str) -> tuple[str, dict[str, Any]]:
        """Text and usage of the last assistant message in `pi --mode json` output, usage renamed to Claude's keys."""
        ends = [json.loads(line) for line in stdout.splitlines() if '"message_end"' in line]
        m = next(e['message'] for e in reversed(ends) if e['message'].get('role') == 'assistant')  # StopIteration: none
        u = m.get('usage') or {}
        return transcripts.text_of(m.get('content')), {
            'input_tokens': u.get('input', 0),
            'output_tokens': u.get('output', 0),
            'cache_read_input_tokens': u.get('cacheRead', 0),
            'cache_creation_input_tokens': u.get('cacheWrite', 0),
            'cost_usd': (u.get('cost') or {}).get('total'),
            'model': f'{m.get("provider")}/{m.get("model")}',
        }

    def failure(self, out: subprocess.CompletedProcess[str]) -> str:
        """Pi prints no JSON envelope on failure: the raw output tail."""
        return f'{out.stdout[-300:]} {out.stderr[-300:]}'.strip()
