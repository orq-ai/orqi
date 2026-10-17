"""The note index shown at session start: skills, then rules, then notes newest first, full lines while they fit, then
names, then a count."""

from __future__ import annotations

from typing import TYPE_CHECKING

from . import settings
from . import store as notes_store  # the functions below take a `store` path, which would hide the module

if TYPE_CHECKING:
    from pathlib import Path

__all__ = ['USE_NOTES', 'USE_RULES', 'USE_SKILLS', 'index', 'index_line']

USE_NOTES = (
    'Knowledge notes about this repository, from earlier sessions here, are in `{notes_dir}/`, listed below as '
    '"path — title — trigger — age". Before you start, and whenever the task changes, read the notes whose trigger '
    'matches it. Treat a note as a fact observed in an earlier session: use it, and verify it when the code has '
    'changed; older notes are more likely stale. To correct a note, edit or delete its file.'
)
USE_SKILLS = (
    'Skills distilled from this repository\'s notes, listed as "path — when to use": read the file and follow it when '
    'its description matches what you are about to do.'
)

USE_RULES = (
    'Rules: lessons seen in two or more sessions in this repository. Follow a rule when its trigger matches what you '
    'are about to do.'
)


def index_line(path: Path, n: dict[str, str]) -> str:
    line = f'- `{path}` — {n["title"]} — {n["trigger"]} — {notes_store.age_days(n["created"], path)}d old'
    line += f' — seen in {n["sightings"]} sessions' if n.get('sightings') else ''
    return line + (f' — verify: {n["verify"]}' if n.get('verify') else '')


def _newest_first(found: dict[str, Path]) -> list[Path]:
    return sorted(found.values(), key=lambda p: p.stat().st_mtime, reverse=True)


def index(store: Path, cwd: str | None = None) -> tuple[str, dict[str, list[str]]]:
    """The note listing for the prompt, and which file names got a full line, a name only, or no mention. Notes, rules
    and skills come from the machine store and, for `cwd`'s repository, from its folder too (`store.files`)."""
    listed: dict[str, list[str]] = {'full': [], 'names': [], 'unlisted': []}
    lines, rules, used = [], [], 0
    # rules, from rules/ or still in notes/, newest first. ponytail: they skip the size budget; a few percent of a store
    rule_files = notes_store.files(store, cwd, 'rules')
    for p in _newest_first(rule_files):
        rules.append(index_line(p, notes_store.parse_note(p.read_text())))
        listed['full'].append(p.name)
    notes_dirs = notes_store.dirs(store, cwd, 'notes').reads
    notes_dir = '/` and `'.join(map(str, notes_dirs))  # one folder, or the machine's and the repository's
    for p in _newest_first(notes_store.files(store, cwd, 'notes')):
        if p.name in rule_files:  # rules/ holds the name too: listed with the rules above
            continue
        n = notes_store.parse_note(p.read_text())
        if not listed['names']:  # once a note is listed by name only, every older one is too
            line = index_line(p, n)
            if used + len(line) <= settings.INDEX_FULL_CHARS:
                lines.append(line)
                listed['full'].append(p.name)
                used += len(line)
                continue
        tier = 'names' if not listed['unlisted'] and used + len(p.name) <= settings.INDEX_CHARS else 'unlisted'
        listed[tier].append(p.name)
        used += len(p.name) if tier == 'names' else 0
    skills = [
        f'- `{p}` — {notes_store.split_frontmatter(p.read_text())[0].get("description", "")}'
        for p in notes_store.files(store, cwd, 'skills').values()
    ]
    if not lines and not listed['names'] and not skills and not rules:
        return '', listed
    lines = [USE_NOTES.format(notes_dir=notes_dir), '', *lines]
    if rules:
        lines = [USE_RULES, *rules, '', *lines]
    if skills:
        lines = [USE_SKILLS, *skills, '', *lines]
    if listed['names']:
        names = ', '.join(f'`{name}`' for name in listed['names'])
        lines += ['', f'Older notes in `{notes_dir}/`, by file name (the name carries the title): {names}']
    if listed['unlisted']:
        hint = f'`grep -ril <word> {" ".join(map(str, notes_dirs))}`'
        lines += ['', f'{len(listed["unlisted"])} more notes are not listed: search for words from your task ({hint}).']
    return '\n'.join(lines), listed
