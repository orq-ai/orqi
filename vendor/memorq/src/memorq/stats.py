"""Numbers from log lines, one source for `report` and the dashboard."""

from __future__ import annotations

import collections
from typing import Any, TypedDict

from . import records, settings

__all__ = ['Funnel', 'funnel']


class Funnel(TypedDict):
    """What `funnel` returns."""

    sessions: int
    skipped: int  # too short to learn from (or another reason a memory gives); not a paused one
    paused: int  # learning was paused for the repository: never learnt
    errors: int
    candidates: int
    accepted: int
    accepted_by_kind: dict[str, int]
    rejected: dict[str, int]  # reason code -> count, most common first
    cost: float
    tokens_in: int
    tokens_out: int
    by_agent: dict[str, int]
    last_error: str
    corrections: int
    corrections_vague: int
    corrections_repeated: int


def funnel(sessions: list[dict[str, Any]]) -> Funnel:
    """What happened to a store's sessions: consolidated, skipped, paused, failed; candidates, accepted, rejected; cost.

    One source for `report` and the dashboard. `corrections*` count what the reviewer did with the user's
    corrections: `corrections_repeated` are corrections rejected as duplicates, so memory already had them.
    """
    done = [r for r in sessions if 'skipped' not in r and 'error' not in r]
    by_kind: collections.Counter[str] = collections.Counter()
    rejected: collections.Counter[str] = collections.Counter()
    corrections: collections.Counter[str] = collections.Counter()
    for r in done:
        for d, c in records.valid_decisions(r.get('decisions', []), r.get('candidates', [])):
            if d.get('decision') == 'accept':
                by_kind[c.get('kind') or '?'] += 1
            else:
                rejected[d.get('reason_code') or '?'] += 1
            if c.get('kind') == 'correction':
                corrections['all'] += 1
                corrections[d.get('reason_code') or '?'] += d.get('decision') != 'accept'
    usage = [u for r in done for u in (r.get('consolidate_usage'), r.get('review_usage')) if u]
    return {
        'sessions': len(done),
        'skipped': sum(1 for r in sessions if 'skipped' in r and r['skipped'] != 'paused'),
        'paused': sum(1 for r in sessions if r.get('skipped') == 'paused'),
        'errors': sum(1 for r in sessions if 'error' in r),
        'candidates': sum(len(r.get('candidates', [])) for r in done),
        'accepted': sum(by_kind.values()),
        'accepted_by_kind': dict(by_kind),
        'rejected': dict(rejected.most_common()),
        'cost': round(sum(u.get('cost_usd') or 0 for u in usage), 2),
        'tokens_in': sum(u.get(k, 0) for u in usage for k in settings.IN_TOKENS),
        'tokens_out': sum(u.get('output_tokens', 0) for u in usage),
        'by_agent': dict(collections.Counter(r.get('agent', 'claude') for r in done)),
        'last_error': next((str(r['error']) for r in reversed(sessions) if 'error' in r), ''),
        'corrections': corrections['all'],
        'corrections_vague': corrections['vague'],
        'corrections_repeated': corrections['duplicate'],
    }
