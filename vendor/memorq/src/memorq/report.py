"""`/memorq:notes`: per-repository counts from the logs, then this repository's notes and last review decisions."""

from __future__ import annotations

import collections
from typing import TYPE_CHECKING

from . import records as note_records  # `report` has a local named `records`
from . import settings, stats
from . import store as notes_store  # `report` has a local named `store`, which would hide the module

if TYPE_CHECKING:
    from pathlib import Path

__all__ = ['report']


def _lines(notes: list[tuple[str, dict[str, str]]]) -> list[str]:
    return [f'- `{name}` [{n["kind"]}] {n["title"]} — {n["trigger"]}' for name, n in notes]


def _where(store: Path, cwd: str, kind: str) -> str:
    """The folders a kind is read from: the store's, then the repository's when it has one."""
    return ', '.join(map(str, notes_store.dirs(store, cwd, kind).reads))


def report(cwd: str) -> str:
    out = []
    for log in sorted(settings.ROOT.glob('*/log.jsonl')):
        records = notes_store.read_log(log.parent)
        dreams = [r for r in records if r.get('dream')]
        sessions = note_records.sessions(records)
        f = stats.funnel(sessions)
        reads = {(r['session'], n) for r in sessions for n in r.get('read_notes', [])}  # a part can be logged twice
        out += [
            f'## {log.parent.name}',
            f'sessions consolidated: {f["sessions"]} (skipped {f["skipped"]}'
            + (f', paused {f["paused"]})' if f['paused'] else ')'),
            f'errors: {f["errors"]}' + (f' (last: {f["last_error"][:200]})' if f['errors'] else ''),
            f'by agent: {f["by_agent"]}',
            f'candidates: {f["candidates"]}',
            f'accepted by kind: {f["accepted_by_kind"]}',
            f'rejected by reason: {f["rejected"]}',
            f'sessions that read a note: {len({s for s, _ in reads})}',
            f'notes read: {dict(collections.Counter(n for _, n in reads))}',
            f'consolidation tokens: in {f["tokens_in"]} out {f["tokens_out"]} cost ${f["cost"]:.2f}',
        ]
        if dreams:
            last = dreams[-1]
            out.append(
                f'dreams: {len(dreams)} (last {last["ts"]}: rules {len(last.get("written", []))}, '
                f'skills {len(last.get("skills", []))}, moved aside '
                f'{len(last.get("superseded", [])) + len(last.get("retired", []))}'
                f'{", error: " + last["error"][:120] if last.get("error") else ""})'
            )
        out.append('')
    if (key := notes_store.repo_key(cwd)) and (store := settings.ROOT / key).exists():
        notes = [
            (name, notes_store.parse_note(p.read_text())) for name, p in notes_store.files(store, cwd, 'notes').items()
        ]
        out += [f'## Notes for {key} ({_where(store, cwd, "notes")})', *_lines(notes)]
        out += ['', f'## Rules for {key} ({_where(store, cwd, "rules")})', *_lines(notes_store.load_rules(store, cwd))]
        if done := [
            r for r in note_records.sessions(notes_store.read_log(store)) if 'skipped' not in r and 'error' not in r
        ]:
            last, titles = done[-1], [c['title'] for c in done[-1].get('candidates', [])]
            out += ['', f'## Last consolidation ({last["session"]}, {last["ts"]})']
            for d in last.get('decisions', []):
                i = d.get('index')
                title = titles[i] if isinstance(i, int) and 0 <= i < len(titles) else '?'
                out.append(f'- {d.get("decision")} [{d.get("reason_code")}] {title}: {d.get("reason", "")}')
    return '\n'.join(out) or 'No knowledge notes yet.'
