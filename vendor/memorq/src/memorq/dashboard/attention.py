"""The dashboard's "Needs attention" list: what to act on in one store, from its collected numbers.

Fixed rules and thresholds over the dicts `collect` returns; each problem says what is wrong, what to do, and which
notes-table filter lists the notes concerned. Never reads a store, never renders HTML.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from . import text

if TYPE_CHECKING:
    from .data import StoreView

__all__ = ['LEVELS', 'Problem', 'error_fix', 'problems']

LEVELS = ('error', 'warn', 'info')
Problem = tuple[str, str, str, 'tuple[str, str, str] | None']  # level, what is wrong, what to do, table filter


# ponytail: substring match on the error text; a structured error class in the log would be exact
_ERROR_FIXES = (
    (
        ('session limit', 'usage limit', 'resets '),
        "The model CLI's subscription hit its usage limit; notes are written again once it resets.",
    ),
    (
        ('429', 'rate limit', 'rate_limit', 'overloaded', '529'),
        'The model provider rate-limited or was overloaded. It usually passes by itself; if it keeps happening, the'
        ' sessions are ending faster than the provider allows.',
    ),
    (
        ('401', '403', 'unauthorized', 'forbidden', 'api key', 'api_key', 'authentication', 'login'),
        'The model call was refused: check the login or API key the plugin calls the model with (claude -p or pi -p).',
    ),
    (
        ('timeout', 'timed out'),
        'The model call timed out. It usually passes by itself; if it keeps happening, the sessions may be too long.',
    ),
    (
        ('command not found', 'no such file', 'enoent'),
        'The model CLI was not found: install claude or pi, or put it on PATH for the hooks.',
    ),
)


def error_fix(error: str) -> str:
    """What to do about a failed model call, by what its error text says."""
    low = error.lower()
    fix = next((fix for words, fix in _ERROR_FIXES if any(w in low for w in words)), '')
    return (fix or 'Check the model the plugin calls (claude -p or pi -p).') + (
        ' Those sessions wrote no notes, and are not retried; details in ~/.memorq/hook.log.'
    )


def problems(s: StoreView) -> list[Problem]:
    """What to act on in one store, most serious first. ponytail: fixed rules and thresholds; tune them here."""
    f, r, p, notes = s['funnel'], s['reading'], s['promotion'], s['notes']
    n, out = len(notes), []
    log = '~/.memorq/hook.log'
    if f['errors']:
        out.append((
            'error',
            f'{text.plural(f["errors"], "session")} failed to consolidate. Last error: {f["last_error"][:200]}',
            error_fix(f['last_error']),
            None,
        ))
    if p['last_result'] and p['last_result']['error']:
        out.append((
            'error',
            f'The last dream failed: {p["last_result"]["error"][:200]}',
            f'Run /memorq:dream to retry; details in {log}.',
            None,
        ))
    if n and f['sessions'] >= 3 and not r['sessions_reading']:
        out.append((
            'warn',
            'No session has opened a note yet.',
            'Check the notes are listed at session start (/memorq:notes shows the index). If they are, the triggers may not'
            ' match the work.',
            None,
        ))
    elif n >= 5 and f['sessions'] >= 3 and r['never_read'] / n > 0.5:
        out.append((
            'warn',
            f'{r["never_read"]} of {n} notes were never opened.',
            'Normal for a young store. If it lasts, the triggers may be too narrow or the notes not worth reading.',
            ('unread', '1', 'never read'),
        ))
    if r['failed_reads']:
        out.append((
            'warn',
            f'{r["failed_reads"]} note read(s) failed.',
            'A session opened a note that had been moved or deleted; the list refreshes at the next session start.',
            None,
        ))
    verify = sum(1 for x in notes if x['verify'])
    if verify:
        out.append((
            'warn',
            f'{text.plural(verify, "note")} flagged to verify.',
            'The dream found them possibly wrong. Open each one, then fix or delete the file.',
            ('verify', '1', 'flagged to verify'),
        ))
    if f['corrections_repeated']:
        out.append((
            'warn',
            f'{text.plural(f["corrections_repeated"], "correction")} repeated a lesson the store already had.',
            'The agent did not open the note or did not follow it: check its trigger, or let the dream make it a rule.',
            None,
        ))
    if s['lookalikes']:
        out.append((
            'info',
            f'{text.plural(s["lookalikes"], "pair")} of notes look alike.',
            'Possible duplicates, or a rule next to the note it should have folded in. Merge them by hand or let the'
            ' dream fold them.',
            ('twin', '1', 'look-alike notes'),
        ))
    tiers = s['index_tiers']
    if tiers['unlisted']:
        out.append((
            'info',
            f'{tiers["unlisted"]} notes are not listed at session start.',
            'The list is full; agents find these only by searching. The dream merges and retires notes to make room.',
            ('tier', 'unlisted', 'unlisted'),
        ))
    elif tiers['names']:
        out.append((
            'info',
            f'{tiers["names"]} notes are listed by file name only.',
            'The list is past its full-line budget: agents see their titles, not their triggers.',
            ('tier', 'names', 'name only'),
        ))
    if r['heat']['cold']:
        out.append((
            'info',
            f'{r["heat"]["cold"]} notes not opened in 30+ days.',
            'Candidates to merge or delete; the dream retires notes it finds stale.',
            ('heat', 'cold', 'opened 30+ days ago'),
        ))
    if f['candidates'] >= 10 and f['accepted'] / f['candidates'] < 0.2:
        reason = next(iter(f['rejected']), '?')
        out.append((
            'info',
            f'The reviewer kept only {100 * f["accepted"] // f["candidates"]}% of candidates.',
            f'Most common reason: {reason}. The Writer funnel (i) says what it means.',
            None,
        ))
    if p['state'] == 'ready':
        out.append((
            'info',
            'A dream is due.',
            'It runs in the background at the next session start, or now with /memorq:dream.',
            None,
        ))
    return out
