"""Harnesses: the agents memorq works with, each an adapter module in this package, listed in HARNESSES.

A harness has `transcripts` (reads its session files into steps) and, optionally, `model` (one headless call through
its CLI, to write notes; without one, Claude's CLI writes them) and `events` (its hook event names, mapped to the
neutral events of settings.EVENTS). To add one, write a module here with those classes and add a line to HARNESSES; or
keep it outside the plugin and name it in ORQ_NOTES_HARNESSES=package.module:HARNESS (comma-separated). The harness's
glue, in integrations/<name>/, runs the plugin's `hook` command on its events: see docs/extending.md.
"""

from __future__ import annotations

import functools
import sys
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from .. import extensions, settings
from . import atif, claude_code, pi

if TYPE_CHECKING:
    import subprocess
    from collections.abc import Mapping
    from pathlib import Path

    from .. import transcripts

__all__ = ['HARNESSES', 'Harness', 'Model', 'Transcripts', 'detect', 'get', 'model_for', 'registered', 'reviewer']


class Transcripts(Protocol):
    def detect(self, path: Path) -> bool:
        """Whether this harness wrote the file."""
        ...

    def session_id(self, path: Path) -> str:
        """The session's id: state.json keeps a cursor per id, and notes name it as their source."""
        ...

    def read(self, path: Path, cursor: int) -> tuple[list[transcripts.Step], int]:
        """The steps after `cursor` (0: from the start), and the cursor to pass next time."""
        ...


class Model(Protocol):
    def available(self) -> bool:
        """Whether the CLI is installed."""
        ...

    def command(self, system: str) -> list[str]:
        """The headless command; the user message goes to its stdin."""
        ...

    def parse(self, stdout: str) -> tuple[str, dict[str, Any]]:
        """The reply text, and usage with Claude's keys (input_tokens, output_tokens, cache_*, cost_usd, model)."""
        ...

    def failure(self, out: subprocess.CompletedProcess[str]) -> str:
        """The CLI's own error message, for the log."""
        ...


@dataclass(frozen=True)
class Harness:
    name: str  # logged as the record's `agent`
    transcripts: Transcripts
    model: Model | None = None
    events: Mapping[str, str] = field(default_factory=dict)  # native hook event name -> neutral (settings.EVENTS)


HARNESSES: dict[str, Harness] = {  # detection order: the first whose transcripts accept a file reads it
    h.name: h
    for h in (
        Harness('pi', pi.Transcripts(), pi.Model(), pi.EVENTS),
        Harness('atif', atif.Transcripts()),  # no hooks: Harbor consolidates its trajectories by hand
        Harness('claude', claude_code.Transcripts(), claude_code.Model(), claude_code.EVENTS),  # last: any JSON lines
    )
}


@functools.cache
def _outside(spec: str) -> Harness | None:
    """The harness a `package.module:attr` spec names, or None after one stderr line (printed once per process)."""
    try:
        harness = extensions.resolve(spec, {})
        if not (isinstance(getattr(harness, 'name', None), str) and hasattr(harness, 'transcripts')):
            raise TypeError(f'{harness!r} is not a Harness (it needs `name` and `transcripts`)')
    except Exception as e:  # anything an outside module raises on import
        print(f'✗ ORQ_NOTES_HARNESSES={spec}: {type(e).__name__}: {e}', file=sys.stderr)
        return None
    return harness  # type: ignore[no-any-return]


def registered() -> dict[str, Harness]:
    """The harnesses ORQ_NOTES_HARNESSES names, then the built-in ones (an outside one may replace a built-in).

    An entry that does not load (a typo, a module not on the hooks' python path, a value that is not a harness) is
    skipped with one stderr line, printed once per process: it must not stop the built-in harnesses, nor the dream.
    """
    outside: dict[str, Harness] = {}
    for spec in (s.strip() for s in settings.HARNESSES.split(',')):
        if spec and (harness := _outside(spec)):
            outside[harness.name] = harness
    return {**outside, **{name: h for name, h in HARNESSES.items() if name not in outside}}


def get(name: str) -> Harness:
    """The harness called `name`. KeyError when there is none."""
    harnesses = registered()
    if name not in harnesses:
        raise KeyError(f'no harness {name!r}: one of {", ".join(harnesses)}, or add it with ORQ_NOTES_HARNESSES')
    return harnesses[name]


def _accepts(h: Harness, path: Path) -> bool:
    """Whether `h` wrote the file; an outside harness whose `detect` raises owns nothing, after one stderr line."""
    try:
        return h.transcripts.detect(path)
    except Exception as e:  # an outside harness must not stop the built-in ones, nor Claude as the fallback
        print(f'✗ harness {h.name}: detect: {type(e).__name__}: {e}', file=sys.stderr)
        return False


def detect(path: Path, name: str | None = None) -> Harness:
    """The harness `name`, or the first whose transcripts accept the file.

    A `name` not registered here (an outside harness whose ORQ_NOTES_HARNESSES the hook's environment lacks) falls back
    to detection, after one stderr line: the session still gets notes, read by whichever harness accepts the file.
    """
    harnesses = registered()
    if name in harnesses:
        return harnesses[name]
    if name:
        print(
            f'✗ harness {name} is not registered here (ORQ_NOTES_HARNESSES); detecting from the file', file=sys.stderr
        )
    for h in harnesses.values():
        if _accepts(h, path):
            return h
    raise LookupError(f'no harness accepts {path}')  # not reached while Claude's transcripts accept any file


def model_for(name: str) -> Model:
    """The harness's own model CLI, or Claude's for a harness without one."""
    model = get(name).model
    return model if model is not None else HARNESSES['claude'].model  # type: ignore[return-value]


def reviewer(name: str) -> str:
    """Which harness reviews `name`'s candidates: Claude whenever its CLI is installed, so one reviewer decides what
    enters the shared store (Pi's default model accepted nearly everything); otherwise the harness itself."""
    claude = HARNESSES['claude'].model
    return 'claude' if claude is not None and claude.available() else name
