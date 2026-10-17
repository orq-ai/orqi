"""Claude Code: transcripts are JSON lines under ~/.claude/projects, appended as the session runs (the cursor is a
byte offset); notes are written with `claude -p`."""

from __future__ import annotations

import contextlib
import json
import shutil
from typing import TYPE_CHECKING, Any

from .. import settings, transcripts

if TYPE_CHECKING:
    import subprocess
    from pathlib import Path

__all__ = ['EVENTS', 'Model', 'Transcripts', 'failed_note_reads', 'projection', 'to_steps', 'tool_inputs']

# Claude Code's hook events (hook_event_name on stdin), as neutral events. integrations/claude-code/hooks.json subscribes
# to these; the neutral ones are answered with these names too.
EVENTS = {
    'SessionStart': 'session_start',
    'UserPromptSubmit': 'prompt',
    'PreCompact': 'compact',
    'SessionEnd': 'session_end',
}


def to_steps(events: list[dict[str, Any]]) -> list[transcripts.Step]:
    """Claude Code transcript lines (and Pi entries, converted by pi.from_pi) as steps. Meta lines are dropped."""
    steps: list[transcripts.Step] = []
    for e in events:
        if e.get('isMeta') or e.get('type') not in {'user', 'assistant'}:
            continue
        sub = bool(e.get('isSidechain'))
        content = (e.get('message') or {}).get('content')
        if e['type'] == 'user':
            steps.append(transcripts.Step('user', transcripts.text_of(content), subagent=sub))
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            kind = b.get('type')
            if kind == 'tool_use':
                text = json.dumps(b.get('input'), ensure_ascii=False)
                steps.append(
                    transcripts.Step(
                        'tool_call', text, tool=b.get('name') or '', call_id=b.get('id') or '', subagent=sub
                    )
                )
            elif kind in {'text', 'thinking'} and e['type'] == 'assistant':
                steps.append(transcripts.Step(kind, b.get(kind) or '', subagent=sub))
            elif kind == 'tool_result':
                result = b.get('content')
                text = result if isinstance(result, str) else json.dumps(result)
                steps.append(
                    transcripts.Step(
                        'tool_result', text, call_id=b.get('tool_use_id') or '', error=b.get('is_error'), subagent=sub
                    )
                )
    return steps


# For callers that hold Claude Code events. `projection` and `tool_inputs`: this repository's tests and the research
# eval (its tests reach them as `kn.projection`, `kn.tool_inputs`). `failed_note_reads`: this repository's tests only.
def projection(events: list[dict[str, Any]]) -> dict[str, Any]:
    return transcripts.project(to_steps(events))


def tool_inputs(events: list[dict[str, Any]]) -> list[str]:
    return transcripts.tool_call_inputs(to_steps(events))


def failed_note_reads(events: list[dict[str, Any]], notes_dir: Path) -> int:
    return transcripts.failed_reads(to_steps(events), notes_dir)


class Transcripts:
    def detect(self, path: Path) -> bool:  # the fallback: any JSON-lines file
        return True

    def session_id(self, path: Path) -> str:
        return path.stem

    def read(self, path: Path, cursor: int) -> tuple[list[transcripts.Step], int]:
        events, end = transcripts.read_events(path, cursor)
        return to_steps(events), end


class Model:
    def available(self) -> bool:
        return shutil.which('claude') is not None

    def command(self, system: str) -> list[str]:
        cmd = ['claude', '-p', '--output-format', 'json', '--model', settings.MODEL, '--system-prompt', system]
        cmd += ['--max-turns', '1', '--no-session-persistence', '--tools', '']
        # Run from the store with project settings only: user plugins (this one too), MCP servers and skills stay out.
        # Cuts ~45K tokens of context per call, and is a second recursion guard next to ORQ_NOTES_CHILD.
        return [*cmd, '--setting-sources', 'project']

    def parse(self, stdout: str) -> tuple[str, dict[str, Any]]:
        envelope = json.loads(stdout)
        model = ','.join(envelope.get('modelUsage') or {})  # what `--model sonnet` resolved to, e.g. claude-sonnet-5-5
        usage = {**envelope.get('usage', {}), 'cost_usd': envelope.get('total_cost_usd'), 'model': model}
        return envelope.get('result') or '', usage

    def failure(self, out: subprocess.CompletedProcess[str]) -> str:
        """The CLI's own error (`claude -p` reports e.g. a 404 for an unknown model in its JSON), else the raw output tail."""
        with contextlib.suppress(ValueError, AttributeError):
            envelope = json.loads(out.stdout)
            return f'{envelope.get("api_error_status") or ""} {envelope.get("result") or ""}'.strip()[:300]
        return f'{out.stdout[-300:]} {out.stderr[-300:]}'.strip()
