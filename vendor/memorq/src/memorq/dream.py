"""The dream pass: one model call over the whole store; recurring lessons become rules, procedures become skills."""

from __future__ import annotations

import collections
import contextlib
import itertools
import json
import shutil
import time
from pathlib import Path
from typing import Any

from . import background, llm, settings, transcripts
from . import records as note_records  # `dream_input` has a local named `records`, which would hide the module
from . import store as notes_store  # several functions here have a local named `store`, which would hide the module

__all__ = ['_aside', 'apply_dream', 'dream', 'dream_input', 'instruction_files', 'maybe_dream', 'render_skill']


def instruction_files(cwd: str) -> list[Path]:
    return [p for name in settings.INSTRUCTION_FILES if (p := Path(cwd) / name).is_file()]


def dream_input(store: Path, instructions: list[Path], cwd: str | None = None) -> dict[str, Any]:
    """Every note with its reads and age, the rules and skills earlier passes wrote, the candidates set aside as vague or
    duplicate, the instruction files. Notes, rules and skills from the store and `cwd`'s repository folder."""
    records = notes_store.read_log(store)
    reads: collections.Counter[str] = collections.Counter(n for r in records for n in set(r.get('read_notes', [])))

    def entry(name: str, path: Path) -> dict[str, Any]:
        n = notes_store.parse_note(path.read_text())
        return {'id': name, **n, 'reads': reads[name], 'age_days': notes_store.age_days(n['created'], path)}

    # rules apart from notes, like skills: in one list the model reads two duplicate rules as two agreeing notes
    notes = list(itertools.starmap(entry, notes_store.files(store, cwd, 'notes').items()))
    rules = list(itertools.starmap(entry, notes_store.files(store, cwd, 'rules').items()))
    parked = []
    for r in records:
        for d, c in note_records.valid_decisions(r.get('decisions', []), r.get('candidates', [])):
            if d.get('decision') == 'reject' and d.get('reason_code') in {'vague', 'duplicate'}:
                kept = {k: v for k, v in c.items() if k != 'evidence'}
                parked.append({
                    **kept,
                    'id': f'c{len(parked)}',
                    'session': r['session'],
                    'reason_code': d['reason_code'],
                })
    texts = {str(p): p.read_text()[:20_000] for p in instructions if p.is_file()}
    # earlier passes' skills, so a pass rewrites or replaces one instead of re-proposing it under a new name
    skills = [
        {'name': name, 'skill': p.read_text()[:4000]} for name, p in notes_store.files(store, cwd, 'skills').items()
    ]
    return {'notes': notes, 'rules': rules, 'parked': parked, 'instructions': texts, 'skills': skills}


def render_skill(skill: dict[str, Any], name: str) -> str:
    steps = '\n'.join(f'{i}. {step}' for i, step in enumerate(skill['steps'], start=1))
    sources = sorted(set(skill['sources']))
    return (
        f'---\nname: {name}\ndescription: {skill["description"].strip()}\nsightings: {len(sources)}\n'
        f'sources: {", ".join(sources)}\ncreated: {time.strftime("%Y-%m-%d")}\n---\n'
        f'# {skill["name"].strip()}\n\nUse when: {skill["description"].strip()}\n\n## Steps\n\n{steps}\n\n'
        f'From notes: {", ".join(skill.get("notes", []))}\n'
    )


def _aside(store: Path, name: str, record: dict[str, Any], into: str, cwd: str | None = None) -> None:
    """Move the note or rule named `name`, from whichever folder holds it (the repository's too), into the machine
    store's superseded/, unless a person wrote it, and drop its shadowed copies in the other root or folder (a
    human-edited one stays, and is reported)."""
    found = notes_store.copies(store, name, cwd)
    seen = record['superseded'] + record['retired'] + record['kept_human_edited']
    if not found or name in seen:
        return
    if notes_store.human_edited(found[0]):
        record['kept_human_edited'].append(name)
        return
    if notes_store.set_aside(store, found):
        record['kept_human_edited'].append(name)
    record[into].append(name)


def apply_dream(store: Path, data: dict[str, Any], record: dict[str, Any], cwd: str | None = None) -> None:
    """Write rules and skills, move folded and retired notes aside, annotate. Caller holds the lock. Rules and skills go
    to `store.dirs(store, cwd, kind).write` (the repository's folder when it has one); what is moved aside goes to the
    machine store's superseded/."""
    record.update(
        written=[], superseded=[], retired=[], annotated=[], skills=[], skills_replaced=[], kept_human_edited=[]
    )
    notes_store.migrate_rules(store)  # rules still in notes/ first, so a rule folded or replaced below is in rules/
    (store / 'notes').mkdir(exist_ok=True)
    # the model sometimes names an older rule by its title, not its file
    rule_files = {n['title']: name for name, n in notes_store.load_rules(store, cwd)}
    rules_dir = None  # resolved at the first write, never before: see store.write_dir
    for r in data.get('rules') or []:
        sources = sorted({s for s in r.get('sources') or [] if isinstance(s, str)})
        if len(sources) < 2 or not all(r.get(k) for k in ('title', 'rule', 'applies_when')):
            continue
        note = {
            'title': r['title'],
            'trigger': r['applies_when'],
            'body': r['rule'],
            'why': r.get('why', ''),
            'kind': 'rule',
        }
        # digest in the name must match parse_note
        note = {k: transcripts.redact(str(v)).strip() for k, v in note.items()}
        name = notes_store.note_filename(note)
        meta = {'sightings': len(sources), 'sources': ', '.join(sources)}
        rules_dir = rules_dir or notes_store.write_dir(store, cwd, 'rules')
        (rules_dir / name).write_text(notes_store.render_note(note, 'dream', meta))
        record['written'].append(name)
        # a rewrite keeps its name: a copy in the other root or in notes/ would sit shadowed behind the new one
        for old in notes_store.copies(store, name, cwd):
            if old != rules_dir / name:
                if notes_store.human_edited(old):
                    record['kept_human_edited'].append(name)
                else:
                    (store / 'superseded').mkdir(exist_ok=True)
                    shutil.move(str(old), str(store / 'superseded' / name))
        for fold in [*(r.get('folds') or []), *(r.get('replaces') or [])]:  # replaces: older rules it restates
            if isinstance(fold, str) and rule_files.get(fold, fold) != name:
                _aside(store, rule_files.get(fold, fold), record, 'superseded', cwd)
    for x in data.get('retire') or []:
        if isinstance(x.get('note'), str) and x['note'] not in record['written']:
            _aside(store, x['note'], record, 'retired', cwd)
    for x in data.get('annotate') or []:
        path = notes_store.note_path(store, str(x.get('note')), cwd)
        if path.exists() and x.get('text') and not notes_store.human_edited(path):
            meta, body = notes_store.split_frontmatter(path.read_text())
            meta['verify'] = transcripts.redact(str(x['text']).replace('\n', ' '))
            path.write_text('---\n' + ''.join(f'{k}: {v}\n' for k, v in meta.items()) + '---\n' + body)
            record['annotated'].append(path.name)
    replaces: set[str] = set()
    skills_dir = None
    for sk in (data.get('skills') or [])[: settings.SKILLS_MAX]:
        sources = {s for s in sk.get('sources') or [] if isinstance(s, str)}
        steps = [s for s in sk.get('steps') or [] if isinstance(s, str) and s.strip()]
        if len(sources) < 2 or len(steps) < 2 or not sk.get('name') or not sk.get('description'):
            continue
        name = notes_store.slug(sk['name'])
        skills_dir = skills_dir or notes_store.write_dir(store, cwd, 'skills')
        (skills_dir / name).mkdir(exist_ok=True)
        (skills_dir / name / 'SKILL.md').write_text(transcripts.redact(render_skill(sk, name)))
        record['skills'].append(name)
        replaces.update(notes_store.slug(x) for x in sk.get('replaces') or [] if isinstance(x, str))
    for old in sorted(replaces - set(record['skills'])):  # slug() keeps the name inside skills/
        if found := notes_store.copies(store, old, cwd, ('skills',)):  # in either root: every copy goes
            (store / 'superseded' / 'skills').mkdir(parents=True, exist_ok=True)
            shutil.move(str(found[0]), str(store / 'superseded' / 'skills' / old))
            for shadow in found[1:]:  # a skill has no digest to tell a person's from ours: as the winner, it goes
                shutil.rmtree(shadow)
            record['skills_replaced'].append(old)
    record['kept_human_edited'].sort()
    record['superseded'].sort()


def dream(key: str, instructions: list[Path], *, dry_run: bool = False, cwd: str | None = None) -> dict[str, Any]:
    """One pass over the store. `cwd`, the directory the pass was started for, adds its repository's folder: read with
    the store, and where rules and skills are written when it holds rules/ or skills/."""
    store = settings.ROOT / key
    record: dict[str, Any] = {
        'ts': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'dream': True,
        'instructions': list(map(str, instructions)),
    }
    with notes_store.locked(store) if not dry_run else contextlib.nullcontext():  # a dry run reads only, no lock file
        prompt = (settings.PROMPTS / 'dream.md').read_text()
        try:
            data, record['usage'] = llm.llm_json(
                prompt, transcripts.redact(json.dumps(dream_input(store, instructions, cwd)))
            )
        except (RuntimeError, OSError) as e:
            data, record['error'] = {}, str(e)[:500]
        if dry_run:
            print(json.dumps(data, indent=1))
            return record
        apply_dream(store, data, record, cwd)
        state = notes_store.load_state(store)
        state['dream'] = {'at': time.time(), 'sessions': len(state['sessions'])}
        notes_store.save_state(store, state)
        notes_store.append_log(store, record)
    return record


def _due(store: Path, cwd: str | None = None) -> dict[str, Any] | None:
    """The store's state when a dream is due: enough sessions since the last one, a day or more ago, enough notes (in
    the store and `cwd`'s repository folder)."""
    state = notes_store.load_state(store)
    last = state.get('dream', {'at': 0, 'sessions': 0})
    if (
        len(state['sessions']) - last['sessions'] >= settings.DREAM_SESSIONS
        and time.time() - last['at'] >= settings.DREAM_IDLE_S
        and len(notes_store.paths(store, cwd)) >= settings.DREAM_MIN_NOTES
    ):
        return state
    return None


def maybe_dream(store: Path, key: str, cwd: str) -> None:
    """Spawn a dream when enough sessions landed since the last one, a day or more ago, in a store worth the call.

    The conditions are checked first without the lock, so a session start with no dream due never touches it. Then
    the check is repeated and the attempt claimed under the store lock, taken without waiting: when two session starts
    race (two copies of the plugin installed), one claims the pass and the other skips. A busy lock, or a store where
    no lock file can be created, skips too; the next session start tries again.
    """
    if not settings.DREAM or not (store / 'state.json').exists() or not _due(store, cwd):
        return
    with notes_store.try_locked(store) as held:
        if not held or not (state := _due(store, cwd)):
            return
        last = state.get('dream', {'at': 0, 'sessions': 0})
        state['dream'] = {'at': time.time(), 'sessions': last['sessions']}  # the attempt counts before it runs
        notes_store.save_state(store, state)  # so a second session start seconds later does not spawn a second pass
        files = instruction_files(cwd)
        background.spawn([
            'dream',
            '--key',
            key,
            '--cwd',
            cwd,
            *(['--instructions', *map(str, files)] if files else []),
        ])
