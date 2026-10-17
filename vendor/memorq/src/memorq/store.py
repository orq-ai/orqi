"""The store on disk: one folder per repository with notes/, rules/, skills/, superseded/, log.jsonl and state.json.

Each kind (notes/, rules/, skills/) can also live in the repository, in `.memorq/` (or `.orq/knowledge/`, where the
factory put it): when that folder holds the kind's folder, both are read and new files go to the repository's. The
bookkeeping (superseded/, state.json, log.jsonl, vectors.json, the lock) stays in the machine store.

Note files are Markdown with a small frontmatter; a machine-written note is named `<slug>-<8 hex>.md` from a digest
of its trigger and body.
"""

from __future__ import annotations

import contextlib
import datetime
import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple

if TYPE_CHECKING:
    from collections.abc import Iterator

__all__ = [
    'KINDS',
    'LOCK_WAIT_S',
    'Busy',
    'Dirs',
    'Note',
    'age_days',
    'append_log',
    'by_age',
    'copies',
    'dirs',
    'files',
    'human_edited',
    'keep_dir',
    'load_all',
    'load_notes',
    'load_rules',
    'load_state',
    'locked',
    'migrate_rules',
    'note_filename',
    'note_path',
    'parse_note',
    'paths',
    'paused',
    'promote',
    'read_log',
    'read_notes',
    'render_note',
    'repo_key',
    'repo_root',
    'rule_paths',
    'save_state',
    'set_aside',
    'set_paused',
    'slug',
    'split_frontmatter',
    'try_locked',
    'wait_locked',
    'write_dir',
]

KINDS = ('notes', 'rules', 'skills')  # the folders a store keeps what it learnt in


def repo_key(cwd: str) -> str | None:
    """`owner__name` from the origin remote, else the main checkout's directory name. Same for every worktree.

    `ORQ_NOTES_KEY` names the store directly, for working directories that are not git repositories. None when there
    is neither, or git is missing or hangs. Never raises.
    """
    if key := os.getenv('ORQ_NOTES_KEY'):
        return re.sub(r'[^A-Za-z0-9._-]', '-', key)

    def git(*args: str) -> str:
        try:
            out = subprocess.run(['git', '-C', cwd, *args], capture_output=True, text=True, check=False, timeout=5)
        except (OSError, subprocess.SubprocessError):  # git missing (FileNotFoundError), or a timeout: as a failure
            return ''
        return out.stdout.strip() if out.returncode == 0 else ''

    if url := git('remote', 'get-url', 'origin'):
        parts = re.split(r'[/:]', url.removesuffix('.git').rstrip('/'))[-2:]
        return re.sub(r'[^A-Za-z0-9._-]', '-', '__'.join(parts))
    if common := git('rev-parse', '--path-format=absolute', '--git-common-dir'):
        return Path(common).parent.name
    return None


def repo_root(cwd: str | None) -> Path | None:
    """The repository's knowledge folder for `cwd`: `<top>/.memorq` when it exists, else `<top>/.orq/knowledge` when
    that does (the factory's workspace step writes it), else `<top>/.memorq`, where one would be created. None when
    there is no cwd, it is not in a git repository, or git is missing or hangs: the machine store alone. Never
    raises."""
    if cwd is None:
        return None
    try:
        out = subprocess.run(
            ['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=False, timeout=5
        )
    except (OSError, subprocess.SubprocessError):  # git missing (FileNotFoundError), or a timeout
        return None
    if out.returncode != 0 or not (top := out.stdout.strip()):
        return None
    own, factory = Path(top) / '.memorq', Path(top) / '.orq' / 'knowledge'
    return factory if not own.is_dir() and factory.is_dir() else own


class Dirs(NamedTuple):
    """Where one kind lives: the folders read, machine first (a later one wins a name both hold), and the one written
    to."""

    reads: tuple[Path, ...]
    write: Path


def _dirs(store: Path, root: Path | None, kind: str) -> Dirs:
    machine = store / kind
    repo = root / kind if root is not None and (root / kind).is_dir() else None
    return Dirs((machine, repo), repo) if repo else Dirs((machine,), machine)


def dirs(store: Path, cwd: str | None, kind: str) -> Dirs:
    """The machine store's folder for `kind`, plus the repository's when `repo_root(cwd)` holds one: then it is read
    after the machine's and written to. Per kind: a repository with notes/ and no rules/ keeps its rules on the
    machine."""
    return _dirs(store, repo_root(cwd), kind)


def _md(folder: Path) -> list[Path]:
    """The Markdown files in one folder, by name: the only place a folder of notes or rules is listed."""
    return sorted(folder.glob('*.md'))


def _listing(store: Path, root: Path | None, kind: str) -> dict[str, Path]:
    """Name -> path for every file of `kind` in its read folders, a later folder winning a name; a skill by its
    folder."""
    found: dict[str, Path] = {}
    for folder in _dirs(store, root, kind).reads:
        if kind == 'skills':
            found.update((p.parent.name, p) for p in sorted(folder.glob('*/SKILL.md')))
        else:
            found.update((p.name, p) for p in _md(folder))
    return found


def _is_rule(path: Path) -> bool:
    return split_frontmatter(path.read_text())[0].get('kind') == 'rule'


def _files(store: Path, root: Path | None, kind: str) -> dict[str, Path]:
    found = _listing(store, root, kind)
    if kind in {'notes', 'rules'}:
        notes = found if kind == 'notes' else _listing(store, root, 'notes')
        legacy = {name: p for name, p in notes.items() if _is_rule(p)}  # rules from before rules/ was a folder
        found = {n: p for n, p in found.items() if n not in legacy} if kind == 'notes' else {**legacy, **found}
    return dict(sorted(found.items()))


def files(store: Path, cwd: str | None, kind: str) -> dict[str, Path]:
    """Name -> path for every note, rule or skill (`kind`) in `dirs(store, cwd, kind).reads`, in name order, each name
    once: the repository's copy wins a name both roots hold. A rule still in notes/ (from before rules/ was a folder)
    is a rule here, not a note; rules/ wins its name. A skill is named by its folder and its path is its SKILL.md."""
    return _files(store, repo_root(cwd), kind)


def paths(store: Path, cwd: str | None = None) -> dict[str, Path]:
    """Name -> path for every note and every rule, in name order, each name once (rules/ wins)."""
    root = repo_root(cwd)
    found = {**_files(store, root, 'notes'), **_files(store, root, 'rules')}
    return dict(sorted(found.items()))


def slug(title: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', title.strip().lower()).strip('-') or 'knowledge-note'


def note_filename(note: dict[str, Any]) -> str:
    digest = hashlib.sha256((note['trigger'] + '\n' + note['body']).encode()).hexdigest()[:8]
    return f'{slug(note["title"])}-{digest}.md'


def render_note(note: dict[str, Any], source: str, meta: dict[str, Any] | None = None) -> str:
    head = {'kind': note.get('kind', ''), 'source': source, 'created': time.strftime('%Y-%m-%d'), **(meta or {})}
    why = f'\nWhy: {note["why"].strip()}\n' if note.get('why') else ''
    return (
        '---\n' + ''.join(f'{k}: {v}\n' for k, v in head.items()) + '---\n'
        f'# {note["title"]}\n\nTrigger: {note["trigger"]}\n{why}\n{note["body"].strip()}\n'
    )


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if text.startswith('---\n') and '\n---\n' in text[4:]:
        head, body = text[4:].split('\n---\n', 1)
        return dict(line.split(': ', 1) for line in head.splitlines() if ': ' in line), body
    return {}, text


def human_edited(path: Path) -> bool:
    """A person changed this note: its name no longer carries the digest of its trigger and body.

    Notes written here are named `<slug>-<8 hex>.md` from `note_filename`; frontmatter is not part of the digest, so
    the dream may annotate a note and still own it. A hand-written file without a digest is a person's too.
    """
    note = parse_note(path.read_text())
    return not path.name.endswith('-' + note_filename(note).rsplit('-', 1)[1])


def parse_note(text: str) -> dict[str, str]:
    meta, text = split_frontmatter(text)
    lines = text.strip().splitlines()
    title = lines[0].removeprefix('# ').strip() if lines else ''
    trigger = next((ln.removeprefix('Trigger:').strip() for ln in lines if ln.startswith('Trigger:')), '')
    why = next((ln.removeprefix('Why:').strip() for ln in lines if ln.startswith('Why:')), '')
    body = '\n'.join(ln for ln in lines[1:] if not ln.startswith(('Trigger:', 'Why:'))).strip()
    note = {
        'title': title,
        'trigger': trigger,
        'body': body,
        'kind': meta.get('kind', ''),
        'created': meta.get('created', ''),
    }
    if why:
        note['why'] = why
    note.update({k: meta[k] for k in ('sightings', 'sources', 'verify') if k in meta})
    return note


def age_days(created: str, path: Path) -> int:
    """Days since the note was written: `created` from its frontmatter, else the file's mtime."""
    with contextlib.suppress(ValueError):
        return (datetime.datetime.now().astimezone().date() - datetime.date.fromisoformat(created)).days
    return int((time.time() - path.stat().st_mtime) // 86400)


def load_notes(store: Path, cwd: str | None = None) -> list[tuple[str, dict[str, str]]]:
    """(filename, note) for every file in the notes/ folders, rules not migrated yet included, in filename order."""
    return [(name, parse_note(p.read_text())) for name, p in sorted(_listing(store, repo_root(cwd), 'notes').items())]


def rule_paths(store: Path, cwd: str | None = None) -> list[Path]:
    """Every rule file, in filename order: rules/*.md, and a legacy rule in notes/ whose name rules/ does not hold."""
    return list(files(store, cwd, 'rules').values())


def load_rules(store: Path, cwd: str | None = None) -> list[tuple[str, dict[str, str]]]:
    """(filename, note) for every rule, in rules/ or still in notes/, each name once, in filename order."""
    return [(name, parse_note(p.read_text())) for name, p in files(store, cwd, 'rules').items()]


def load_all(store: Path, cwd: str | None = None) -> list[tuple[str, dict[str, str]]]:
    """(filename, note) for every note and every rule, each name once (rules/ wins), in filename order."""
    return [(name, parse_note(p.read_text())) for name, p in paths(store, cwd).items()]


def copies(store: Path, name: str, cwd: str | None = None, kinds: tuple[str, ...] = ('rules', 'notes')) -> list[Path]:
    """Every file (a skill: folder) named `name` in the `kinds` folders of both roots, the one `paths` answers with
    first: rules/ before notes/, the repository's before the machine's. The others are shadowed copies. One file
    reached by two paths (a repository folder that is a link to the machine's) is listed once, by its first path."""
    root = repo_root(cwd)
    found: dict[Path, Path] = {}  # resolved -> the first path that reached it
    for kind in kinds:
        for folder in reversed(_dirs(store, root, kind).reads):
            if (path := folder / name).exists():
                found.setdefault(path.resolve(), path)
    return list(found.values())


def note_path(store: Path, name: str, cwd: str | None = None) -> Path:
    """Where the note or rule named `name` is, as `paths` would say; else the machine's notes/ (which does not hold it
    either)."""
    return next(iter(copies(store, name, cwd)), store / 'notes' / name)


def set_aside(store: Path, found: list[Path]) -> list[Path]:
    """Move `found[0]`, a note or rule, into the machine store's superseded/ and delete the other copies of its name
    (`copies`), so a shadowed one cannot come back in its place; a human-edited copy stays. Returns the copies kept.
    The caller holds the lock and has decided about `found[0]`."""
    (store / 'superseded').mkdir(parents=True, exist_ok=True)
    shutil.move(str(found[0]), str(store / 'superseded' / found[0].name))
    kept = [p for p in found[1:] if human_edited(p)]
    for p in found[1:]:
        if p not in kept:
            p.unlink()
    return kept


def write_dir(store: Path, cwd: str | None, kind: str) -> Path:
    """`dirs(store, cwd, kind).write`, resolved now: the repository's folder only while it exists, and never created
    (a checkout or a removed worktree can take it away during a minute-long model call; recreating it would write where
    nothing reads), else the machine store's, created as needed."""
    target = dirs(store, cwd, kind).write
    if target == store / kind:
        target.mkdir(parents=True, exist_ok=True)
    return target


def migrate_rules(store: Path) -> list[str]:
    """Move the rules still in notes/ into rules/, keeping each name (so `human_edited` still holds), and return the
    names moved. A legacy rule whose name rules/ already holds stays where it is: rules/ wins, nothing is overwritten.
    Idempotent. The caller holds the store lock."""
    moved = []
    for path in filter(_is_rule, _md(store / 'notes')):  # the machine store only: a repository's files are its own
        if (dest := store / 'rules' / path.name).exists():
            continue
        dest.parent.mkdir(exist_ok=True)
        path.rename(dest)
        moved.append(path.name)
    return moved


def keep_dir(folder: Path) -> Path:
    """Create `folder` (and its parents) with an empty `.gitkeep`, so git keeps it while it holds nothing else."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / '.gitkeep').touch()
    return folder


def promote(store: Path, cwd: str, kinds: tuple[str, ...] = ('rules', 'skills')) -> list[Path]:
    """Move the machine store's rules (`rules/*.md`) and skills (`skills/<slug>/`) of `kinds` into the repository
    folder of `cwd` (`repo_root(cwd) / kind`, created with a `.gitkeep`), each under its own name, and return where
    they went. Legacy rules still in notes/ are migrated first, so they are carried along. A name the repository
    already holds stays on the machine, with one stderr line. Logs `promoted` when anything moved. Under the store
    lock, waited on for LOCK_WAIT_S at most. Outside a git repository: nothing, [].

    Raises:
        Busy: a consolidation or a dream held the lock all that time; nothing moved.
    """
    if (root := repo_root(cwd)) is None:
        return []
    moved = []
    with wait_locked(store, LOCK_WAIT_S):
        migrate_rules(store)
        for kind in kinds:
            folder = store / kind
            # a skill is a folder holding a SKILL.md, as every reader lists them; any other folder stays
            found = _md(folder) if kind == 'rules' else sorted(p.parent for p in folder.glob('*/SKILL.md'))
            if not found:
                continue
            target = keep_dir(root / kind)
            for path in found:
                if (dest := target / path.name).exists():
                    print(f'memorq: {path.name} already in {target}, left on this machine', file=sys.stderr)
                    continue
                try:
                    path.rename(dest)
                except OSError as e:  # only another file system is copied; a folder that appeared at dest is not
                    if e.errno != errno.EXDEV:
                        raise
                    shutil.move(str(path), str(dest))
                moved.append(dest)
        if moved:
            append_log(store, {'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'promoted': [str(p) for p in moved]})
    return moved


def by_age(notes_dir: Path) -> list[Path]:
    return sorted(_md(notes_dir), key=lambda p: p.stat().st_mtime, reverse=True)


@dataclass(frozen=True)
class Note:
    """A note as retrieval sees it. `name` is the file name: the note's id in logs, indexes and vectors.json."""

    name: str
    title: str
    trigger: str
    body: str
    kind: str = ''
    created: str = ''

    @property
    def text(self) -> str:
        """Title, trigger and body: what lexical and vector search read."""
        return f'{self.title}\n{self.trigger}\n{self.body}'


def read_notes(store: Path, cwd: str | None = None) -> list[Note]:
    """Every note and rule in the store, each name once (rules/ wins), newest first (file modification time)."""
    notes = []
    for path in sorted(paths(store, cwd).values(), key=lambda p: p.stat().st_mtime, reverse=True):
        n = parse_note(path.read_text())
        notes.append(Note(path.name, n['title'], n['trigger'], n['body'], n['kind'], n['created']))
    return notes


def load_state(store: Path) -> dict[str, Any]:
    path = store / 'state.json'
    return json.loads(path.read_text()) if path.exists() else {'since': time.time(), 'sessions': {}}


def save_state(store: Path, state: dict[str, Any]) -> None:
    (store / 'state.json').write_text(json.dumps(state, indent=1))


LOCK_WAIT_S = 5.0  # how long `set_paused` and `promote` wait for a store a consolidation or a dream holds


class Busy(Exception):  # noqa: N818  # the store's name says what is busy
    """The store lock stayed held (a consolidation or a dream) for all of LOCK_WAIT_S."""


def paused(store: Path) -> bool:
    """Whether learning is paused for the store (`memorq.py pause`): its notes are still recalled, nothing is learnt.
    Reading never creates the store. A state.json that cannot be read, or is not a JSON object, pauses nothing: the
    hooks check this outside any action, where an exception would cost the session its index."""
    try:
        state = load_state(store)
    except Exception:  # unreadable, not UTF-8, not JSON: read as learning
        return False
    return isinstance(state, dict) and state.get('paused') is True


def set_paused(store: Path, on: bool) -> None:  # noqa: FBT001
    """Pause or resume learning for the store, creating it and its state.json if needed. Under the store lock, which
    consolidation and the dream hold while they rewrite state.json, so neither can save over the change. The lock is
    polled, not waited on: a consolidation holds it across a model call.

    Raises:
        Busy: the lock stayed held for LOCK_WAIT_S; state.json is untouched.
        ValueError: state.json is not JSON or not UTF-8; it is untouched.
        TypeError: state.json is JSON but not an object; it is untouched.
        OSError: state.json cannot be read or written.
    """
    with wait_locked(store, LOCK_WAIT_S):
        state = load_state(store)
        if not isinstance(state, dict):
            raise TypeError('not a JSON object')
        state['paused'] = on
        save_state(store, state)


@contextlib.contextmanager
def locked(store: Path) -> Iterator[None]:
    store.mkdir(parents=True, exist_ok=True)
    with (store / '.lock').open('w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


@contextlib.contextmanager
def wait_locked(store: Path, seconds: float) -> Iterator[None]:
    """The store lock, polled for up to `seconds` rather than waited on: a consolidation holds it across a model call,
    and a command must not hang behind one.

    Yields:
        Once this process holds the lock.

    Raises:
        Busy: the lock stayed held (or could not be created) for all of `seconds`.
    """
    deadline = time.monotonic() + seconds
    while True:
        with try_locked(store) as held:
            if held:
                yield
                return
        if (left := deadline - time.monotonic()) <= 0:
            raise Busy(store.name)
        time.sleep(min(0.2, left))


@contextlib.contextmanager
def try_locked(store: Path) -> Iterator[bool]:
    """The store lock without waiting, for a hook, so a busy lock skips the work instead of blocking.

    Yields:
        True when this process now holds the lock; False when another one does (consolidating, dreaming, or claiming a
        dream), or the lock file cannot be created (a read-only store), and the caller skips its work this time.
    """
    try:
        store.mkdir(parents=True, exist_ok=True)
        f = (store / '.lock').open('w')
    except OSError:
        yield False
        return
    with f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:  # busy (EWOULDBLOCK), or no locks on this file system: skip rather than block
            yield False
        else:
            yield True


def read_log(store: Path) -> list[dict[str, Any]]:
    """Every line of `<store>/log.jsonl` that parses to a JSON object, in order. No log means no records."""
    path = store / 'log.jsonl'
    if not path.exists():
        return []
    records = []
    for line in path.read_text().splitlines():
        with contextlib.suppress(ValueError):
            if isinstance(record := json.loads(line), dict):
                records.append(record)
    return records


def append_log(store: Path, record: dict[str, Any]) -> None:
    store.mkdir(parents=True, exist_ok=True)
    with (store / 'log.jsonl').open('a') as f:
        f.write(json.dumps(record) + '\n')
