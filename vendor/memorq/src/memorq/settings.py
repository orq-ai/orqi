"""Settings and tuning constants. Read once, at import; a caller can set them (`settings.X = v`).

The settings named in FILE_KEYS can also live in `<ROOT>/settings.json`, which a settings screen writes (`write`): its
environment variable wins when set, the file beats the default, and SOURCE says which one each came from. The rest are
read from the environment only. Every other module reads these as `settings.NAME` at call time, never copies them.
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    'API_KEY_FILE',
    'BM25_B',
    'BM25_K1',
    'CHAT_URL',
    'CONTEXT_PCT',
    'DEFAULT_ON',
    'DREAM',
    'DREAM_IDLE_S',
    'DREAM_MIN_NOTES',
    'DREAM_SESSIONS',
    'EMBED_CHARS',
    'EMBED_MODEL',
    'EMBED_URL',
    'ENABLED',
    'EVENTS',
    'FILE_KEYS',
    'HARNESSES',
    'IDLE_S',
    'INDEX_CHARS',
    'INDEX_FULL_CHARS',
    'INSTRUCTION_FILES',
    'IN_TOKENS',
    'KEEP',
    'KEEP_PARTS',
    'LEGACY_ROOT',
    'LLM',
    'MAX_CHARS',
    'MAX_ITEMS',
    'MEMORY',
    'MIN_TOOL_CALLS',
    'MODEL',
    'ON',
    'ORQ_MODEL',
    'PI_MODEL',
    'PROMPTS',
    'RANK',
    'RANK_TOP',
    'ROOT',
    'ROUTER',
    'RRF_K',
    'RRF_WEIGHTS',
    'SKILLS_MAX',
    'SOURCE',
    'SWEEP_IDLE_S',
    'SWEEP_MAX',
    'effective',
    'file',
    'parse_value',
    'write',
]


T = TypeVar('T')

# The settings the file can hold, as a settings screen lists them. `on.<event>` is ORQ_NOTES_ON_<EVENT>, a
# comma-separated string of actions; the rest are named after their variable (DREAM_SESSIONS is `dream_every`).
FILE_KEYS: tuple[str, ...] = (
    'enabled',
    'on.session_start',
    'on.prompt',
    'on.compact',
    'on.checkpoint',
    'on.ship',
    'on.idle',
    'on.session_end',
    'on.manual',
    'context_pct',
    'idle_s',
    'rank',
    'rank_top',
    'dream',
    'dream_every',
    'orq_model',
    'pi_model',
)
_INT_KEYS = ('context_pct', 'idle_s', 'rank_top', 'dream_every')
_ENABLED_VALUES = ('on', 'readonly', 'off')
# Where each FILE_KEY came from: 'env', 'file' or 'default'.
SOURCE: dict[str, str] = dict.fromkeys(FILE_KEYS, 'default')


def _positive(value: str) -> int | None:
    """A positive integer written out, else None: a malformed or non-positive value is no value."""
    return int(value) if value.isdecimal() and int(value) > 0 else None


def _positive_int(name: str, default: int) -> int:
    """An integer setting from the environment; a missing, malformed or non-positive value keeps the default."""
    return _positive(os.getenv(name, '')) or default


def _wrong(key: str, value: object) -> str:
    """What a value of `key` must be, when `value` is not one; '' when it is."""
    if key in _INT_KEYS:
        return '' if type(value) is int and value > 0 else 'a positive integer'
    if key == 'dream':
        return '' if isinstance(value, bool) else 'true or false'
    if key == 'enabled':
        return '' if value in _ENABLED_VALUES else ' or '.join(_ENABLED_VALUES)
    return '' if isinstance(value, str) else 'a string'


def _read(path: Path) -> dict[str, Any]:
    """The JSON object in `path`: {} when there is no file, and also, with one stderr line, when it holds no object."""
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:  # ValueError covers bad JSON and bad UTF-8
        why = str(e)
    else:
        if isinstance(data, dict):
            return data
        why = f'a JSON {type(data).__name__}, not an object'
    print(f'memorq: ignoring {path}: {why}', file=sys.stderr)
    return {}


def _target() -> Path:
    """The settings file, read at import and written by `write`: ROOT's, unless the default ROOT does not exist yet and
    LEGACY_ROOT does. Before the move (migrate.move_root) the stores and the file are still in LEGACY_ROOT; creating
    ROOT there would leave both behind, as move_root never moves into a ROOT that exists. A root someone chose
    (ORQ_NOTES_HOME) is never moved into, so its file is always its own."""
    default_root = LEGACY_ROOT.parent.parent / '.memorq'
    chosen = os.getenv('ORQ_NOTES_HOME') or default_root != ROOT
    if not chosen and not ROOT.exists() and LEGACY_ROOT.exists():
        return LEGACY_ROOT / 'settings.json'
    return ROOT / 'settings.json'


def _file() -> dict[str, Any]:
    """The settings file's valid FILE_KEYS, read once at import; a bad value is dropped, with one stderr line."""
    path = _target()
    data = _read(path)
    for key in [k for k in FILE_KEYS if k in data and _wrong(k, data[k])]:
        print(f'memorq: ignoring {key} in {path}: {data.pop(key)!r} is not {_wrong(key, None)}', file=sys.stderr)
    return {k: v for k, v in data.items() if k in FILE_KEYS}


def _setting(name: str, key: str, default: T, parse: Callable[[str], T | None] | None = None) -> T:
    """The environment variable `name` when set, else the file's `key`, else `default`; SOURCE[key] records which.

    `parse` turns a string (the variable, or a string in the file) into the value; None from it means no value there.
    """
    value = os.getenv(name)
    if value is not None and (value := parse(value) if parse else value) is not None:
        SOURCE[key] = 'env'
        return value  # type: ignore[return-value]  # without a parse, T is str
    if key in _FROM_FILE:
        stored = _FROM_FILE[key]
        if (value := parse(stored) if parse and isinstance(stored, str) else stored) is not None:
            SOURCE[key] = 'file'
            return value
    SOURCE[key] = 'default'
    return default


def file() -> Path:
    """Where `write` puts the settings file now (migrate.move_root can move ROOT after import)."""
    return _target()


def parse_value(key: str, text: str) -> Any:
    """`text` as a value of `key`, as `write` takes it: an int for the integer keys, true/false (any case) for `dream`,
    else the string as given (an empty `on.*` turns the event off). ValueError for an unknown key or unparseable text;
    `write` still checks the value (a positive integer, a known `enabled`)."""
    if key not in FILE_KEYS:
        raise ValueError(f'{key} is not a setting; known: {", ".join(FILE_KEYS)}')
    if key in _INT_KEYS:
        try:
            return int(text)
        except ValueError:
            raise ValueError(f'{key} must be {_wrong(key, None)}, not {text!r}') from None
    if key == 'dream':
        if text.lower() not in ('true', 'false'):
            raise ValueError(f'{key} must be {_wrong(key, None)}, not {text!r}')
        return text.lower() == 'true'
    return text


def write(updates: dict[str, Any]) -> Path:
    """Merge `updates` into the settings file and return its path; the values take effect on the next import.

    A None value removes its key, so the environment or the default applies again. A key outside FILE_KEYS or a value
    of the wrong kind raises ValueError before anything is written. The file is replaced whole, never left
    half-written.
    """
    for key, value in updates.items():
        if key not in FILE_KEYS:
            raise ValueError(f'{key} is not a setting; known: {", ".join(FILE_KEYS)}')
        if value is not None and (why := _wrong(key, value)):
            raise ValueError(f'{key} must be {why}, not {value!r}')
    path = _target()
    path.parent.mkdir(parents=True, exist_ok=True)  # ROOT itself only when there is no LEGACY_ROOT to move into it
    # Two `settings set` at once: the lock keeps each read-modify-write whole, so neither loses the other's key, and
    # each writes its own temp file, so neither replaces the file with the other's half-written one.
    with path.with_name('settings.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        merged = {k: v for k, v in {**_read(path), **updates}.items() if v is not None}
        fd, name = tempfile.mkstemp(dir=path.parent, prefix='.settings-', suffix='.tmp')
        tmp = Path(name)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(json.dumps(merged, indent=1) + '\n')
            tmp.replace(path)  # os.replace: atomic on one filesystem
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    return path


def effective() -> dict[str, dict[str, Any]]:
    """Each FILE_KEY's value in force and where it came from (SOURCE); `on.*` values as comma-joined actions."""
    values = {
        'enabled': ENABLED,
        'context_pct': CONTEXT_PCT,
        'idle_s': IDLE_S,
        'rank': RANK,
        'rank_top': RANK_TOP,
        'dream': DREAM,
        'dream_every': DREAM_SESSIONS,
        'orq_model': ORQ_MODEL,
        'pi_model': PI_MODEL,
    }
    return {
        key: {
            'value': ','.join(ON.get(key[len('on.') :], ())) if key.startswith('on.') else values[key],
            'source': SOURCE[key],
        }
        for key in FILE_KEYS
    }


def _parts(value: str) -> frozenset[str]:
    """The comma-separated parts of ORQ_NOTES_KEEP that exist; an unknown part is ignored, with one stderr line.

    A value with no valid part (empty, or only unknown ones) keeps the default.
    """
    parts = frozenset(p.strip() for p in value.split(',') if p.strip())
    if unknown := parts - KEEP_PARTS:
        print(
            f'✗ ORQ_NOTES_KEEP: ignored {", ".join(sorted(unknown))}; known: {", ".join(sorted(KEEP_PARTS))}',
            file=sys.stderr,
        )
    return (parts & KEEP_PARTS) or _parts(KEEP_DEFAULT)


def _actions(value: str) -> tuple[str, ...]:
    """The comma-separated action names of an ORQ_NOTES_ON_<EVENT> value, as given; an empty value runs nothing.

    An unknown name is reported when the event fires (hooks.handle), where the actions are known.
    """
    return tuple(a.strip() for a in value.split(',') if a.strip())


def _on() -> dict[str, tuple[str, ...]]:
    """The actions of each neutral event: ORQ_NOTES_ON_<EVENT> when set (even to nothing), else the file's
    `on.<event>`, else DEFAULT_ON."""
    return {
        event: _setting(f'ORQ_NOTES_ON_{event.upper()}', f'on.{event}', DEFAULT_ON[event], _actions) for event in EVENTS
    }


# Where the stores live (ORQ_NOTES_HOME overrides). They used to live in LEGACY_ROOT; migrate.move_root moves them
# once, leaving a link behind.
ROOT = Path(os.getenv('ORQ_NOTES_HOME', Path.home() / '.memorq'))
LEGACY_ROOT = Path.home() / '.orq' / 'knowledge'
_FROM_FILE = _file()

# `ORQ_NOTES`: on (default), readonly (the index is still injected, nothing is written or consolidated) or off.
ENABLED: str = _setting('ORQ_NOTES', 'enabled', 'on', lambda v: v if v in _ENABLED_VALUES else None)


# Hook events, neutral: each harness maps its own event names to these (Harness.events), and ON says which actions
# (hooks.ACTIONS) run on each, in order. Besides start, prompt and end, four events write mid-session, each over the part
# of the session after its cursor: `compact` (before the harness compacts), `checkpoint` (the context crossed
# ORQ_NOTES_CONTEXT_PCT), `ship` (a `git push` or `gh pr create|merge` ran) and `idle` (no input for ORQ_NOTES_IDLE_S).
# Long factory sessions rarely end cleanly, and what a compaction drops is gone. Only the Pi extension sends the last
# three. `manual` is a learn the user asked for. ORQ_NOTES_ON_<EVENT>= (empty) turns one off.
EVENTS = ('session_start', 'prompt', 'compact', 'checkpoint', 'ship', 'idle', 'session_end', 'manual')
DEFAULT_ON: dict[str, tuple[str, ...]] = {
    'session_start': ('sweep', 'maintain', 'index'),
    'prompt': ('rank',),
    'compact': ('consolidate',),
    'checkpoint': ('consolidate',),
    'ship': ('consolidate',),
    'idle': ('consolidate',),
    'session_end': ('consolidate',),
    'manual': ('consolidate',),
}
ON = _on()

# What a write sees of a session part (transcripts.project). `ORQ_NOTES_KEEP` lists the kinds of step kept:
# user (messages), text (assistant text), thinking, tools (calls with their input), errors (tool results that failed),
# results (every tool result), subagents (steps of subagents, dropped by default). Each item is cut to MAX_CHARS; a
# part longer than MAX_ITEMS keeps its first third and last two thirds. The defaults are what the writer was tuned on.
KEEP_PARTS = frozenset({'user', 'text', 'thinking', 'tools', 'errors', 'results', 'subagents'})
KEEP_DEFAULT = 'user,text,tools,errors'
KEEP = _parts(os.getenv('ORQ_NOTES_KEEP', KEEP_DEFAULT))
MAX_CHARS = _positive_int('ORQ_NOTES_MAX_CHARS', 800)
MAX_ITEMS = _positive_int('ORQ_NOTES_MAX_ITEMS', 120)
# `ORQ_NOTES_MEMORY`: notes (default), or package.module:factory for another memory (memory.py).
MEMORY = os.getenv('ORQ_NOTES_MEMORY', 'notes')
# `ORQ_NOTES_HARNESSES`: harnesses from outside the plugin, package.module:HARNESS, comma-separated (memorq/harnesses).
HARNESSES = os.getenv('ORQ_NOTES_HARNESSES', '')

PROMPTS = Path(__file__).resolve().parents[2] / 'prompts'
MODEL = os.getenv('ORQ_NOTES_MODEL', 'sonnet')  # Claude Code sessions
PI_MODEL: str | None = _setting('ORQ_NOTES_PI_MODEL', 'pi_model', None)  # Pi sessions; unset = Pi's default model
# `ORQ_NOTES_LLM=orq`: every model call (writer, reviewer, dream) goes to the orq router over HTTP instead of a harness
# CLI, with ORQ_NOTES_ORQ_MODEL. For a harness with no `claude` or `pi` on PATH: the Pi extension sets it under orqi.
LLM = os.getenv('ORQ_NOTES_LLM', '')
ORQ_MODEL: str = _setting('ORQ_NOTES_ORQ_MODEL', 'orq_model', 'anthropic/claude-sonnet-5-5')
# The index lists every note it can afford, newest first: a full `path — title — trigger — age` line up to
# INDEX_FULL_CHARS (about 2.5k tokens, some 45 notes), then file names only up to INDEX_CHARS (about 5k tokens, some
# 250 notes), then a count and how to search. A cut at the newest 40 hid 47 of 87 notes after 40 sessions of one
# repository, most of the ones its team had also written down as rules. Full lines carry the whole path: given the
# directory in a sentence and the file names in a list, GPT-5.6 Luna asked for `<store>/<file>` without `notes/`
# 128 times in 81 benchmark runs and never read a note in 15 of them.
# The first prompt adds the notes ranked for it on top (`prompt`, see memorq/retrieval.py); the index itself stays by age.
INDEX_FULL_CHARS = 10_000
INDEX_CHARS = 20_000
MIN_TOOL_CALLS = 5
SWEEP_IDLE_S = 600
# The Pi extension's `checkpoint` (context past CONTEXT_PCT percent) and `idle` (IDLE_S seconds with no input) events.
CONTEXT_PCT: int = _setting('ORQ_NOTES_CONTEXT_PCT', 'context_pct', 80, _positive)
IDLE_S: int = _setting('ORQ_NOTES_IDLE_S', 'idle_s', 600, _positive)
SWEEP_MAX = 3
# The dream pass: Claude Code's auto-dream runs after 24 hours and more than 5 sessions; Codex consolidates at
# session start under one lock. Same here, detached from the `maintain` action at session start, with the store lock.
# A failed attempt counts, so a rate-limited `claude -p` is not retried on every session start.
# `ORQ_NOTES_DREAM=off` turns the pass off; `ORQ_NOTES_DREAM_EVERY` is DREAM_SESSIONS (a bad value keeps 5).
DREAM: bool = _setting('ORQ_NOTES_DREAM', 'dream', default=True, parse=lambda v: v != 'off')
DREAM_SESSIONS: int = _setting('ORQ_NOTES_DREAM_EVERY', 'dream_every', 5, _positive)
DREAM_IDLE_S = 86_400
DREAM_MIN_NOTES = 10
INSTRUCTION_FILES = ('AGENTS.md', 'CLAUDE.md')
SKILLS_MAX = 5  # per dream pass, as prompts/dream.md asks
IN_TOKENS = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')

# `ORQ_NOTES_RANK`: bm25 (default), semantic (router embeddings alone), hybrid (BM25 + embeddings; note vectors are
# computed after consolidation, the query is embedded in the hook), off, or `package.module:factory` (a retriever
# from outside the plugin, see memorq/retrieval.py). Offline, on stores of 150 notes or more, BM25's top 10 held the note a task
# needed in 14 of 31 cases against 3 with a full index line; hybrid did no better (factory-memory, retrieval-report.md).
RANK: str = _setting('ORQ_NOTES_RANK', 'rank', 'bm25')
RANK_TOP: int = _setting('ORQ_NOTES_RANK_TOP', 'rank_top', 10, _positive)  # a bad value keeps 10
BM25_K1, BM25_B = 1.2, 0.75
RRF_K, RRF_WEIGHTS = 60, (0.4, 0.6)  # bm25, vector
EMBED_MODEL = os.getenv('ORQ_NOTES_EMBED_MODEL', 'openai/text-embedding-3-small')
ROUTER = os.getenv('ROUTER_BASE_URL', 'https://api.orq.ai/v2/router').rstrip('/')
_ROUTER = ROUTER  # the old name, kept for one release
EMBED_URL = ROUTER + '/embeddings'
CHAT_URL = ROUTER + '/chat/completions'
EMBED_CHARS = 8_000  # per text; about 2k tokens, under the model's 8k limit
API_KEY_FILE = Path.home() / '.orq' / 'api-key'
