"""Hook handlers: a hook event runs the actions that settings.ON lists for it, through the configured memory.

Each harness maps its own event names to the neutral events of settings.EVENTS (Harness.events); its glue, in
integrations/<harness>/, only forwards them to the `hook` command. The default actions are what the hooks always did:
session start (sweep, maintain, index), the first prompt (rank), session end (consolidate in the background).
`start`, `prompt` and `end` are those three events.
"""

from __future__ import annotations

import contextlib
import functools
import inspect
import json
import os
import re
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import background, harnesses, memory, migrate, settings
from . import store as notes_store  # `sweep` and `Context` have a field or parameter named `store`, which would hide it

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    'ACTIONS',
    'PAUSED',
    'WRITES',
    'Context',
    'disabled',
    'end',
    'handle',
    'paused',
    'prompt',
    'readonly',
    'start',
    'sweep',
]


def disabled() -> bool:
    return bool(os.getenv('ORQ_NOTES_CHILD')) or settings.ENABLED == 'off'


def readonly() -> bool:
    """Frozen store: the index is still injected, nothing is written or consolidated."""
    return settings.ENABLED == 'readonly'


def paused(store: Path) -> bool:
    """Learning paused for this repository (`memorq.py pause on`): the index is still injected and no dream runs. The
    learns are still spawned: consolidation reads the pause under the store lock, logs the part `skipped: paused` and
    moves past it, so nothing that ran while paused is learnt later. A bad state.json pauses nothing (store.paused never
    raises)."""
    return notes_store.paused(store)


def _broken(what: str, e: Exception) -> None:
    """One stderr line for the call (`what`) that failed in a hook, its traceback in hook.log; that action then answers
    nothing."""
    print(
        f'✗ {what} (ORQ_NOTES_MEMORY={settings.MEMORY}, ORQ_NOTES_RANK={settings.RANK}): {type(e).__name__}: {e}',
        file=sys.stderr,
    )
    with contextlib.suppress(OSError):  # the agent's UI shows the line; the log keeps what a bug report needs
        settings.ROOT.mkdir(parents=True, exist_ok=True)
        with (settings.ROOT / 'hook.log').open('a', encoding='utf-8') as log:
            log.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {traceback.format_exc()}')


def _memory() -> memory.Memory | None:
    """The configured memory; a bad ORQ_NOTES_MEMORY prints one line and the hook answers nothing."""
    try:
        return memory.make_memory()
    except Exception as e:  # a bad setting, or an outside factory that raises, never breaks a hook
        return _broken('memory', e)


def sweep(store: Path, key: str, transcript: str | None, cwd: str | None = None) -> None:
    store.mkdir(parents=True, exist_ok=True)
    state = notes_store.load_state(store)
    if not (store / 'state.json').exists():
        notes_store.save_state(store, state)  # `since` marks install time; older transcripts are not backfilled
    if transcript:
        now, current = time.time(), Path(transcript)
        stale = [
            p
            for p in current.parent.glob('*.jsonl')
            if p != current
            and state['since'] < p.stat().st_mtime < now - settings.SWEEP_IDLE_S
            and p.stat().st_size > state['sessions'].get(p.stem, 0)
        ]
        if stale:
            where = ['--cwd', cwd] if cwd else []
            background.spawn([
                'consolidate',
                '--key',
                key,
                '--event',
                'sweep',
                *where,
                *map(str, stale[: settings.SWEEP_MAX]),
            ])


@dataclass(frozen=True)
class Context:
    """What an action gets: the hook's stdin JSON, the repository's store key and folder, the working directory, the
    harness named on the event (`hook --harness`; None for `start`, `prompt` and `end`, which name none), and the
    neutral event that fired. `mem`, the configured memory, is built on first use: at most once per event, and only for
    the actions that need it."""

    hook: dict[str, Any]
    key: str
    store: Path
    cwd: str
    harness: str | None
    event: str

    @functools.cached_property
    def mem(self) -> memory.Memory | None:
        """The configured memory, or None after one stderr line (a memory that fails to build is reported once)."""
        return _memory()


def _sweep(ctx: Context) -> None:
    """Consolidate, detached, the sessions next to this one that ended without a session-end hook."""
    sweep(ctx.store, ctx.key, ctx.hook.get('transcript_path'), ctx.cwd)


def _maintain(ctx: Context) -> None:
    """The memory's upkeep (for notes: may spawn the dream)."""
    if mem := ctx.mem:
        mem.maintain(ctx.key, ctx.cwd)


def _migrate_rules(ctx: Context) -> None:
    """Move the store's rules still in notes/ into rules/, before `maintain`. It moves the user's own files and learns
    nothing, so it runs while learning is paused, but never in read-only mode, which writes nothing. Under the store lock
    taken without waiting, as the dream is claimed: a busy lock skips, and the next session start moves them."""
    if not (ctx.store / 'notes').is_dir():
        return
    with notes_store.try_locked(ctx.store) as held:
        if held:
            notes_store.migrate_rules(ctx.store)


def _retrieve(mem: memory.Memory, ctx: Context, query: str | None) -> str:
    """mem.retrieve, with the hook's working directory for a memory whose `retrieve` takes `cwd` (the notes memory reads
    the repository's folder too); one written to the two-argument interface (docs/extending.md) gets two arguments."""
    try:
        takes_cwd = 'cwd' in inspect.signature(mem.retrieve).parameters
    except (TypeError, ValueError):  # no signature to read (a builtin, a C extension): the interface as documented
        takes_cwd = False
    return mem.retrieve(ctx.key, query, cwd=ctx.cwd) if takes_cwd else mem.retrieve(ctx.key, query)


def _index(ctx: Context) -> str | None:
    """What the memory retrieves at session start."""
    return _retrieve(mem, ctx, None) if (mem := ctx.mem) else None


def _rank(ctx: Context) -> str | None:
    """What the memory retrieves for the session's first prompt. Later prompts get nothing.

    ponytail: first prompt only; re-rank on every prompt if agents miss notes when the task changes mid-session.
    """
    if session := ctx.hook.get('session_id'):  # Pi's extension calls once per session itself and sends no id
        marks = Path(tempfile.gettempdir()) / 'orq-notes-ranked'
        marks.mkdir(exist_ok=True)
        try:
            (marks / re.sub(r'[^A-Za-z0-9._-]', '-', session)).open('x').close()
        except FileExistsError:
            return None
    return _retrieve(mem, ctx, ctx.hook.get('prompt') or '') if (mem := ctx.mem) else None


def _consolidate(ctx: Context) -> None:
    """Consolidate the session in a detached process: hook timeouts are short and consolidation takes a minute. Safe
    to run more than once per session (at compaction, say): only the part after the session's cursor is read. The
    event and the working directory go with it, so the learn record names the trigger that fired it."""
    if not ctx.hook.get('transcript_path'):
        return
    # The harness named on the event, else on stdin; with neither (`end`), the harness is detected from the file.
    h = ctx.harness or ctx.hook.get('harness')
    harness = ['--harness', h] if isinstance(h, str) and h else []
    path = ctx.hook['transcript_path']
    background.spawn(['consolidate', '--key', ctx.key, '--event', ctx.event, '--cwd', ctx.cwd, *harness, path])


# What a neutral event can run (settings.ON). Each action returns text for the agent's context, or None.
ACTIONS: dict[str, Callable[[Context], str | None]] = {
    'sweep': _sweep,
    'maintain': _maintain,
    'index': _index,
    'rank': _rank,
    'consolidate': _consolidate,
}
WRITES = frozenset({'sweep', 'maintain', 'consolidate'})  # skipped when readonly()
PAUSED = frozenset({'maintain'})  # skipped when paused(); a learn records the pause itself (consolidate_one)
_CALLS = {'index': 'retrieve', 'rank': 'retrieve'}  # the memory call a failing action's ✗ line names
_CONTEXT = ('session_start', 'prompt')  # the events whose text reaches the agent


def _neutral(event: str, harness: str) -> str | None:
    """`event` if it is neutral, else what the harness maps it to; None for an event that is neither.

    A neutral event needs no harness, and a built-in harness's own names need no outside one: ORQ_NOTES_HARNESSES is
    only loaded for a harness that is not built in, or a name its built-in maps nothing for. So an outside `claude`
    without `events`, or a bad ORQ_NOTES_HARNESSES entry, cannot stop Claude Code's hooks.
    """
    if event in settings.EVENTS:
        return event
    if (builtin := harnesses.HARNESSES.get(harness)) and event in builtin.events:
        return builtin.events[event]
    try:
        h = harnesses.get(harness)
    except KeyError as e:
        print(f'✗ {e.args[0]}', file=sys.stderr)
        return None
    return (getattr(h, 'events', None) or {}).get(event)  # an outside harness may have no `events`


def handle(hook: dict[str, Any], event: str, harness: str | None = None) -> str | None:
    """Run the actions that settings.ON lists for `event` (neutral, or one of the harness's own names), in order.

    `harness` (default: Claude Code's names) maps native event names, and a harness named here also tells consolidation
    which adapter reads the transcript. The texts the actions return, joined by a blank line, come back as hook output
    for the agent's context, named with the native event (Claude Code's name for a neutral one). Only `session_start`
    and `prompt` deliver text: on another event, text prints one line instead. None when there is no text, or when the
    event is neither neutral nor the harness's (Claude Code's `Stop`, say). An unknown action name, or an action that
    raises, prints one line and the other actions still run.
    """
    if disabled() or not (neutral := _neutral(event, harness or 'claude')):
        return None
    migrate.move_root()  # once per process, before any store access
    if not (names := settings.ON.get(neutral, ())):
        return None
    cwd = hook.get('cwd') or str(Path.cwd())
    if not (key := notes_store.repo_key(cwd)):
        return None
    ctx = Context(hook, key, settings.ROOT / key, cwd, harness, neutral)
    texts: list[str] = []
    for name in names:
        if (action := ACTIONS.get(name)) is None:
            known = ', '.join(sorted(ACTIONS))
            print(f'✗ ORQ_NOTES_ON_{neutral.upper()}: unknown action {name}; known: {known}', file=sys.stderr)
            continue
        try:
            if name == 'maintain' and not readonly():
                _migrate_rules(ctx)
            if (name in WRITES and readonly()) or (name in PAUSED and paused(ctx.store)):
                continue
            text = action(ctx)
        except Exception as e:  # an outside memory that fails never breaks a hook, nor the other actions
            _broken(_CALLS.get(name, name), e)
            continue
        if text:
            texts.append(text)
    if not texts:
        return None
    if neutral not in _CONTEXT:  # Claude Code and Pi read additionalContext on these events only
        print(f'✗ ORQ_NOTES_ON_{neutral.upper()}: index and rank text is not delivered on {neutral}', file=sys.stderr)
        return None
    claude = {n: native for native, n in harnesses.HARNESSES['claude'].events.items()}
    native = claude.get(neutral, neutral) if event == neutral else event
    return json.dumps({'hookSpecificOutput': {'hookEventName': native, 'additionalContext': '\n\n'.join(texts)}})


def start(hook: dict[str, Any]) -> str | None:
    """Session start: by default, a detached sweep of sessions that ended without SessionEnd, the memory's upkeep, and
    what the memory retrieves."""
    return handle(hook, 'session_start')


def prompt(hook: dict[str, Any]) -> str | None:
    """A prompt: by default, what the memory retrieves for the session's first prompt."""
    return handle(hook, 'prompt')


def end(hook: dict[str, Any]) -> None:
    """Session end: by default, consolidate the session in a detached process."""
    handle(hook, 'session_end')
