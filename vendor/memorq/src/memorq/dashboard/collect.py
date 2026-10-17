"""The dashboard's numbers: every store under a root turned into plain dicts, and the "All repositories" sums.

Reads only what the plugin already writes (notes/, skills/, superseded/, log.jsonl, state.json), through the same
functions the plugin uses: `index.index` for the session-start tiers, `store.human_edited` for hand edits,
`stats.funnel` for the writer funnel, the DREAM_* settings for readiness. Never renders HTML, never writes a file.
"""

from __future__ import annotations

import collections
import datetime
import operator
import time
from typing import TYPE_CHECKING, Any, cast

from .. import index, records, retrieval, settings, stats
from .. import store as notes_store  # the functions below take a `store` path, which would hide the module

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

    from .data import (
        LastResult,
        Missed,
        Note,
        Page,
        Promotion,
        PromotionTotals,
        Reading,
        Skill,
        StoreView,
        TotalsMissed,
        TotalsView,
        Week,
    )

__all__ = [
    'AGE_BUCKETS',
    'HEAT',
    'LOOKALIKE',
    'STOPWORDS',
    'TOP_READ',
    'WEEKS',
    'bucket',
    'collect',
    'collect_store',
    'days_since',
    'totals',
    'weeks',
]

WEEKS = 12  # the week-by-week table's length
TOP_READ = 6  # notes listed as the most recalled
AGE_BUCKETS = (('0-7', 7), ('8-30', 30), ('31+', 10**9))
HEAT = (('hot', 7), ('warm', 30), ('cold', 10**9))  # days since a session last opened the note


def _int(v: Any, default: int = 1) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def days_since(ts: str) -> int | None:
    """Whole days since a `YYYY-MM-DDTHH:MM:SS` local timestamp; None when it does not parse."""
    try:
        return int((time.time() - time.mktime(time.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S'))) // 86400)
    except (ValueError, OverflowError):
        return None


def _heat(last_read: str) -> str:
    if not last_read:
        return 'never'
    days = days_since(last_read)
    return next(label for label, limit in HEAT if (days if days is not None else 10**9) <= limit)


LOOKALIKE = (
    0.22  # ponytail: word overlap (Jaccard) on title, trigger, body, tuned on real stores; a judge would do better
)
STOPWORDS = frozenset([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'is',
    'are',
    'be',
    'it',
    'this',
    'that',
    'from',
    'by',
    'as',
    'at',
    'use',
    'run',
    'when',
    'not',
    'do',
    'if',
    'you',
    'your',
    'its',
])


def _lookalikes(notes: list[Note]) -> list[tuple[str, str]]:
    """Pairs of live notes that share most of their words: possible duplicates, or a rule next to its instance."""
    words = [
        (
            n['name'],
            {
                t
                for t in retrieval.tokens(f'{n["title"]} {n["trigger"]} {n["body"]}')
                if len(t) > 2 and t not in STOPWORDS
            },
        )
        for n in notes
    ]
    return [
        (a, b)
        for i, (a, wa) in enumerate(words)
        for b, wb in words[i + 1 :]
        if wa and wb and len(wa & wb) / len(wa | wb) >= LOOKALIKE
    ]


def bucket(age: int) -> str:
    """The AGE_BUCKETS label of an age in days."""
    return next(label for label, limit in AGE_BUCKETS if age <= limit)


def _reading(sessions: list[dict[str, Any]], notes: list[Note]) -> Reading:
    def corrected(r: dict[str, Any]) -> bool:
        return any(c.get('kind') == 'correction' for c in r.get('candidates', []))

    top = sorted(notes, key=lambda n: (-n['reads'], n['age']))[:TOP_READ]
    return {
        'sessions_reading': len({r.get('session') for r in sessions if r.get('read_notes')}),
        'failed_reads': sum(r.get('failed_reads', 0) for r in sessions),
        'read_then_corrected': sum(1 for r in sessions if r.get('read_notes') and corrected(r)),
        'never_read': sum(1 for n in notes if n['reads'] == 0),
        'heat': {h: sum(1 for n in notes if n['heat'] == h) for h in ('hot', 'warm', 'cold', 'never')},
        'top': [(n['name'], n['title'], n['reads']) for n in top if n['reads']],
    }


def _monday(ts: str) -> datetime.date | None:
    try:
        day = datetime.date.fromisoformat(str(ts)[:10])
    except ValueError:
        return None
    return day - datetime.timedelta(days=day.weekday())


def _judged(sessions: list[dict[str, Any]]) -> tuple[int, int, int, list[Missed]]:
    """What the reviewer made of the sessions' candidates: already known, noise, corrections, and the repeated ones."""
    known = noise = corrections = 0
    missed: list[Missed] = []
    for r in sessions:
        for d, c in records.valid_decisions(r.get('decisions', []), r.get('candidates', [])):
            rejected, duplicate = d.get('decision') != 'accept', d.get('reason_code') == 'duplicate'
            known += rejected and duplicate
            noise += rejected and not duplicate
            if c.get('kind') == 'correction':
                corrections += 1
                if rejected and duplicate:
                    missed.append({'title': str(c.get('title', '')), 'ts': str(r.get('ts', ''))})
    return known, noise, corrections, missed


def weeks(log: list[dict[str, Any]]) -> list[Week]:
    """The log's numbers per calendar week, oldest first, quiet weeks included, the last WEEKS of them.

    Sessions give the funnel, the reviewer's verdicts and the corrections; dream records give the rules and
    skills written that week.
    """
    by_week: dict[datetime.date, list[dict[str, Any]]] = collections.defaultdict(list)
    for r in log:
        if monday := _monday(r.get('ts', '')):
            by_week[monday].append(r)
    if not by_week:
        return []
    first, last = min(by_week), max(by_week)
    first = max(first, last - datetime.timedelta(weeks=WEEKS - 1))
    out: list[Week] = []
    while first <= last:
        rs = by_week.get(first, [])
        sessions = records.sessions(rs)
        dreams = [r for r in rs if r.get('dream')]
        f = stats.funnel(sessions)
        known, noise, corrections, _ = _judged([r for r in sessions if 'skipped' not in r and 'error' not in r])
        out.append({
            'week': first.isoformat(),
            'sessions': f['sessions'],
            'errors': f['errors'],
            'candidates': f['candidates'],
            'accepted': f['accepted'],
            'reading': len({r.get('session') for r in sessions if r.get('read_notes')}),
            'repeated': f['corrections_repeated'],
            'cost': f['cost'],
            'known': known,
            'noise': noise,
            'corrections': corrections,
            'rules': sum(len(r.get('written') or []) for r in dreams),
            'skills': sum(len(r.get('skills') or []) for r in dreams),
        })
        first += datetime.timedelta(weeks=1)
    return out


def _promotion(store: Path, log: list[dict[str, Any]], notes: list[Note], skills: list[Skill]) -> Promotion:
    dreams = [r for r in log if r.get('dream')]
    state = notes_store.load_state(store) if (store / 'state.json').exists() else None
    last = (state or {}).get('dream', {'at': 0, 'sessions': 0})
    since = len((state or {}).get('sessions', {})) - last['sessions']
    ready = (
        bool(state)
        and since >= settings.DREAM_SESSIONS
        and len(notes) >= settings.DREAM_MIN_NOTES
        and time.time() - last['at'] >= settings.DREAM_IDLE_S
    )
    sightings = collections.Counter('3+' if n['sightings'] >= 3 else str(n['sightings']) for n in notes)
    result = dreams[-1] if dreams else None
    if not settings.DREAM:
        dream_state = 'off'
    elif ready:
        dream_state = 'ready'
    elif result and result.get('error'):
        dream_state = 'error'
    else:
        dream_state = 'waiting'
    return {
        'rules': sum(1 for n in notes if n['kind'] == 'rule'),
        'skills': len(skills),
        'sightings': {k: sightings.get(k, 0) for k in ('1', '2', '3+')},
        'dreams': len(dreams),
        'folded': sum(len(r.get('superseded') or []) for r in dreams),  # single-case notes a dream rule replaced
        'last_dream': dreams[-1]['ts'] if dreams else '',
        'sessions_since_dream': max(since, 0),
        'ready': ready,
        'state': dream_state,
        'notes': len(notes),
        'last_attempt': last['at'],
        'last_result': _last_result(result) if result else None,
    }


def _last_result(result: dict[str, Any]) -> LastResult:
    """What a dream's log line says it did: its error, or how many rules, skills, retired and merged notes."""
    return {
        'error': str(result.get('error', '')),
        'written': len(result.get('written') or []),
        'skills': len(result.get('skills') or []),
        'retired': len(result.get('retired') or []),
        'superseded': len(result.get('superseded') or []),
    }


def collect_store(store: Path) -> StoreView:
    """Everything the page shows for one store, as plain dicts."""
    log = notes_store.read_log(store)
    sessions = records.sessions(log)
    read_by: dict[str, set[str]] = collections.defaultdict(set)
    last_read: dict[str, str] = {}
    for r in sessions:
        for name in set(r.get('read_notes', [])):
            read_by[name].add(r.get('session', '?'))
            last_read[name] = max(last_read.get(name, ''), str(r.get('ts', '')))
    reason: dict[str, str] = {}
    for r in sessions:
        for d, c in records.valid_decisions(r.get('decisions', []), r.get('candidates', [])):
            if d.get('decision') == 'accept':
                reason[notes_store.note_filename(c)] = d.get('reason', '')
    notes: list[Note] = []
    rules = {name for name, _ in notes_store.load_rules(store)}  # a rule in rules/ counts as one whatever its kind says
    for name, n in notes_store.load_all(store):
        path = notes_store.note_path(store, name)
        notes.append({
            'name': name,
            'title': n['title'],
            'trigger': n['trigger'],
            'body': n['body'],
            'kind': 'rule' if name in rules else n['kind'] or '?',
            'created': n['created'],
            'age': notes_store.age_days(n['created'], path),
            'sightings': _int(n.get('sightings', '1')),
            'verify': n.get('verify', ''),
            'human_edited': notes_store.human_edited(path),
            'reads': len(read_by.get(name, [])),
            'read_by': sorted(read_by.get(name, [])),
            'reason': reason.get(name, ''),
            'last_read': last_read.get(name, ''),
            'heat': _heat(last_read.get(name, '')),
            'tier': 'unlisted',  # set below, from the index
            'twin': False,  # set below, from the look-alike pairs
        })
    skills: list[Skill] = []
    for name, p in notes_store.files(store, None, 'skills').items():  # no cwd here: the machine store's
        meta, _ = notes_store.split_frontmatter(p.read_text())
        skills.append({
            'name': meta.get('name', name),
            'description': meta.get('description', ''),
            'sightings': _int(meta.get('sightings', '1')),
            'path': str(p),
        })
    _, tiers = index.index(store) if notes else ('', {'full': [], 'names': [], 'unlisted': []})
    tier_of = {name: tier for tier, names in tiers.items() for name in names}
    for n in notes:
        n['tier'] = tier_of.get(n['name'], 'unlisted')
    pairs = _lookalikes(notes)
    twins = {name for pair in pairs for name in pair}
    for n in notes:
        n['twin'] = n['name'] in twins
    return {
        'key': store.name,
        'notes': notes,
        'kinds': dict(collections.Counter(n['kind'] for n in notes)),
        'ages': {label: sum(1 for n in notes if bucket(n['age']) == label) for label, _ in AGE_BUCKETS},
        'superseded': len(list((store / 'superseded').glob('*.md'))),
        'skills': skills,
        'index_tiers': {k: len(v) for k, v in tiers.items()},
        'last_update': max((r.get('ts', '') for r in log), default=''),
        'lookalikes': len(pairs),
        'funnel': stats.funnel(sessions),
        'reading': _reading(sessions, notes),
        'weeks': weeks(log),
        'missed': sorted(_judged(sessions)[3], key=operator.itemgetter('ts'), reverse=True),
        'promotion': _promotion(store, log, notes, skills),
    }


def collect(root: Path) -> Page:
    """Every store under `root` (a folder with notes/), most notes first; their sums (`all`); the unreadable ones."""
    stores: list[StoreView] = []
    errors: list[tuple[str, str]] = []
    for p in sorted(root.iterdir()):
        if not (p.is_dir() and (p / 'notes').is_dir()):
            continue
        try:
            stores.append(collect_store(p))
        except Exception as e:  # one unreadable store must not blank the page
            errors.append((p.name, str(e)))
    stores.sort(key=lambda s: -len(s['notes']))
    return {
        'stores': stores,
        'errors': errors,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'root': str(root),
        'all': totals(stores),
    }


_FUNNEL_SUMS = (
    'sessions',
    'skipped',
    'paused',
    'errors',
    'candidates',
    'accepted',
    'corrections',
    'corrections_vague',
    'corrections_repeated',
    'tokens_in',
    'tokens_out',
)
_READING_SUMS = ('sessions_reading', 'failed_reads', 'read_then_corrected', 'never_read')
_PROMOTION_SUMS = ('rules', 'skills', 'dreams', 'folded')


def _add(counts: Iterable[dict[str, int]]) -> dict[str, int]:
    """Several {name: count} dicts summed, most common first."""
    c: collections.Counter[str] = collections.Counter()
    for d in counts:
        c.update(d)
    return dict(c.most_common())


def totals(stores: list[StoreView]) -> TotalsView:
    """The 'All repositories' view: sums of the per-store numbers, notes tagged with their store."""
    funnels, readings, promotions = (
        [s['funnel'] for s in stores],
        [s['reading'] for s in stores],
        [s['promotion'] for s in stores],
    )
    funnel = cast(
        'stats.Funnel',
        {
            **{k: sum(f[k] for f in funnels) for k in _FUNNEL_SUMS},
            'rejected': _add(f['rejected'] for f in funnels),
            'cost': round(sum(f['cost'] for f in funnels), 2),
            'by_agent': _add(f['by_agent'] for f in funnels),
            'accepted_by_kind': _add(f['accepted_by_kind'] for f in funnels),
            'last_error': '',
        },
    )
    reading = cast(
        'Reading',
        {
            **{k: sum(r[k] for r in readings) for k in _READING_SUMS},
            'heat': {h: sum(r['heat'][h] for r in readings) for h in ('hot', 'warm', 'cold', 'never')},
            'top': sorted((t for r in readings for t in r['top']), key=lambda t: -t[2])[:TOP_READ],
        },
    )
    promotion = cast(
        'PromotionTotals',
        {
            **{k: sum(p[k] for p in promotions) for k in _PROMOTION_SUMS},
            'sightings': {k: sum(p['sightings'][k] for p in promotions) for k in ('1', '2', '3+')},
            'ready': sum(1 for p in promotions if p['ready']),
            'last_dream': max((p['last_dream'] for p in promotions), default=''),
            'sessions_since_dream': sum(p['sessions_since_dream'] for p in promotions),
            'states': dict(collections.Counter(p['state'] for p in promotions).most_common()),
        },
    )
    by_week: dict[str, Week] = {}
    for w in (w for s in stores for w in s['weeks']):
        o = by_week.get(w['week'])
        by_week[w['week']] = (
            w
            if o is None
            else {
                'week': w['week'],
                'sessions': o['sessions'] + w['sessions'],
                'errors': o['errors'] + w['errors'],
                'candidates': o['candidates'] + w['candidates'],
                'accepted': o['accepted'] + w['accepted'],
                'reading': o['reading'] + w['reading'],
                'repeated': o['repeated'] + w['repeated'],
                'cost': round(o['cost'] + w['cost'], 2),
                'known': o['known'] + w['known'],
                'noise': o['noise'] + w['noise'],
                'corrections': o['corrections'] + w['corrections'],
                'rules': o['rules'] + w['rules'],
                'skills': o['skills'] + w['skills'],
            }
        )
    missed: list[TotalsMissed] = sorted(
        ({**m, 'store': s['key']} for s in stores for m in s['missed']), key=operator.itemgetter('ts'), reverse=True
    )
    return {
        'key': 'All repositories',
        'notes': [{**n, 'store': s['key']} for s in stores for n in s['notes']],
        'kinds': _add(s['kinds'] for s in stores),
        'ages': {k: sum(s['ages'][k] for s in stores) for k in ('0-7', '8-30', '31+')},
        'superseded': sum(s['superseded'] for s in stores),
        'lookalikes': sum(s['lookalikes'] for s in stores),
        'skills': [sk for s in stores for sk in s['skills']],
        'index_tiers': {k: sum(s['index_tiers'][k] for s in stores) for k in ('full', 'names', 'unlisted')},
        'last_update': max((s['last_update'] for s in stores), default=''),
        'funnel': funnel,
        'reading': reading,
        'weeks': [by_week[k] for k in sorted(by_week)][-WEEKS:],
        'missed': missed,
        'promotion': promotion,
    }
