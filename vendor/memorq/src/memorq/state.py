"""What memory knows right now, as plain dicts for `memorq.py state` and `notes`: the panel and the commands read these.

Both only read: no store is created, and a state.json or log line that cannot be read counts as empty rather than
raising, since the panel polls them while a consolidation or a dream rewrites the files.
"""

from __future__ import annotations

import contextlib
import json
import math
import operator
import time
from pathlib import Path
from typing import Any

from . import records, settings
from . import store as notes_store  # the functions below have a local named `store`, which would hide the module

__all__ = ['notes', 'snapshot']

PLUGIN_DIR = Path(__file__).resolve().parents[2]  # src/memorq/state.py -> the plugin folder
RUNNING_S = 3600  # a claimed dream with no record after it is running for this long at most; after that it died


def _version() -> str:
    try:
        return json.loads((PLUGIN_DIR / '.claude-plugin' / 'plugin.json').read_text())['version']
    except (OSError, ValueError, KeyError, TypeError):
        return ''


def _state(store: Path) -> dict[str, Any]:
    """state.json as a dict; one that cannot be read, or is not an object, is empty."""
    try:
        state = notes_store.load_state(store)
    except Exception:  # unreadable, not UTF-8, not JSON
        return {}
    return state if isinstance(state, dict) else {}


def _number(value: Any) -> float | None:  # anything a JSON file holds
    """A finite number as a float, else None: `json.loads` accepts NaN and Infinity, which no count or time is."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        with contextlib.suppress(OverflowError):  # an integer too large for a float
            return float(value) if math.isfinite(value) else None
    return None


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _epoch(ts: Any) -> float:
    """A log record's `ts` as epoch seconds, as `dashboard.collect.days_since` parses it; 0 when it is not one."""
    with contextlib.suppress(TypeError, ValueError, OverflowError):
        return time.mktime(time.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S'))
    return 0.0


def _count(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _learn(r: dict[str, Any]) -> dict[str, Any]:
    costs = [
        c
        for usage in (r.get('consolidate_usage'), r.get('review_usage'))
        if isinstance(usage, dict) and (c := _number(usage.get('cost_usd'))) is not None
    ]
    return {
        'event': _text(r.get('event')) or 'session_end',  # a record from before the event was logged: a session end's
        'written': _count(r.get('written')),
        'cost_usd': sum(costs) if costs else None,
        'ts': _text(r.get('ts')),
    }


def _review(
    state: dict[str, Any],
    last_dream: dict[str, Any] | None,
    n_notes: int,
    paused: bool,  # noqa: FBT001
) -> dict[str, Any] | None:
    """When the next dream is due, or that one is running now; None when none can run: the dream is off
    (settings.DREAM), the store is paused, or it is too small to dream."""
    if not settings.DREAM or paused or n_notes < settings.DREAM_MIN_NOTES:
        return None
    dream: dict[str, Any] = d if isinstance(d := state.get('dream'), dict) else {}
    at = _number(dream.get('at')) or 0.0
    # `maybe_dream` claims a pass by setting `at` a day or more after the last dream; a pass that finishes sets it again,
    # minutes after the `ts` its record carries (taken when it started). So a claim is an `at` a day or more past the
    # last record, a finished pass one its run time past it. Half a day between them leaves room for a long pass and for
    # a `ts` (local time, no zone) read an hour off in the hour a DST change repeats.
    last_ts = _epoch(last_dream.get('ts')) if last_dream else 0.0
    if at - last_ts > settings.DREAM_IDLE_S / 2 and time.time() - at < RUNNING_S:
        return {'running': True, 'notes': n_notes}
    sessions = state.get('sessions')
    since = (len(sessions) if isinstance(sessions, dict) else 0) - int(_number(dream.get('sessions')) or 0)
    return {'due_in_sessions': max(0, settings.DREAM_SESSIONS - since)}


def snapshot(cwd: str, session: str | None = None) -> dict[str, Any]:
    """The state of the store for `cwd`'s repository: version, whether learning is on and paused, the store's key,
    how many notes and rules it holds (both roots), where each kind is written, the log the extension tails, when the
    next review (dream) is due or that it is running (None when none can run), the learns of `session` (oldest first,
    and the last one) and the last review (with its `error` when it failed). Outside a git repository with no ORQ_NOTES_KEY: the same keys, empty."""
    out: dict[str, Any] = {
        'version': _version(),
        'enabled': settings.ENABLED,
        'key': None,
        'notes': 0,
        'paused': False,
        'stores': None,
        'log': None,
        'review': None,
        'learned': None,
        'learns': [],
        'last_review': None,
    }
    if not (key := notes_store.repo_key(cwd)):
        return out
    store = settings.ROOT / key
    log = notes_store.read_log(store)
    dreams = [r for r in log if r.get('dream')]
    last_dream = dreams[-1] if dreams else None
    learns = [
        _learn(r)
        for r in records.sessions(log)
        if session is not None and r.get('session') == session and 'skipped' not in r and 'error' not in r
    ]
    n_notes, paused = len(_listing(store, cwd)), notes_store.paused(store)
    out.update({
        'key': key,
        'notes': n_notes,
        'paused': paused,
        'stores': {kind: str(notes_store.dirs(store, cwd, kind).write) for kind in notes_store.KINDS},
        'log': str(store / 'log.jsonl'),
        'review': _review(_state(store), last_dream, n_notes, paused),
        'learned': learns[-1] if learns else None,
        'learns': learns,
        'last_review': None
        if last_dream is None
        else {
            'ts': _text(last_dream.get('ts')),
            'rules': _count(last_dream.get('written')),
            'skills': _count(last_dream.get('skills')),
            **({'error': error} if (error := _text(last_dream.get('error'))) else {}),
        },
    })
    return out


def _listing(store: Path, cwd: str) -> dict[str, tuple[Path, bool]]:
    """Name -> (path, is a rule) for every note and rule across both reads, each name once: rules/ wins, as `paths`."""
    found = {name: (p, False) for name, p in notes_store.files(store, cwd, 'notes').items()}
    found.update((name, (p, True)) for name, p in notes_store.files(store, cwd, 'rules').items())
    return found


def notes(cwd: str) -> list[dict[str, Any]]:
    """Every note and rule of `cwd`'s repository, across both reads, newest first (file modification time, as the
    index lists them), with how many sessions read each. A file moved away while this reads is left out. Outside a git
    repository with no ORQ_NOTES_KEY: []."""
    if not (key := notes_store.repo_key(cwd)):
        return []
    store = settings.ROOT / key
    read_by: dict[str, set[Any]] = {}
    for r in records.sessions(notes_store.read_log(store)):
        if isinstance(read := r.get('read_notes'), list):
            for name in read:
                if isinstance(name, str):
                    read_by.setdefault(name, set()).add(r.get('session'))
    listed = [n for name, (path, is_rule) in _listing(store, cwd).items() if (n := _note(name, path, is_rule, read_by))]
    return [n for _, n in sorted(listed, key=operator.itemgetter(0), reverse=True)]


def _note(name: str, path: Path, is_rule: bool, read_by: dict[str, set[Any]]) -> tuple[float, dict[str, Any]] | None:  # noqa: FBT001
    """(modification time, the note as `notes` lists it); None when the file was moved away (a dream superseded it)
    between the listing and the read."""
    try:
        note = notes_store.parse_note(path.read_text())
        return path.stat().st_mtime, {
            'name': name,
            'path': str(path),
            'title': note['title'],
            'trigger': note['trigger'],
            'kind': 'rule' if is_rule else note['kind'],
            'age_days': notes_store.age_days(note['created'], path),
            'reads': len(read_by.get(name, ())),
        }
    except OSError:
        return None
