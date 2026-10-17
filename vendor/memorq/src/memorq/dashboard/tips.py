"""The tooltips behind each (i) on the dashboard: one per card, a summary and what each of its rows means.

Plain text (escaped where it is shown), built once at import from the settings the numbers depend on.
"""

from __future__ import annotations

from .. import settings
from . import collect

__all__ = ['HELP']


# One explanation per card, shown by hovering the (i) next to its title: a summary, then what each row means.
HELP: dict[str, tuple[str, dict[str, str]]] = {
    'Writing': (
        'How notes are written. What happened to each finished session: the model proposed candidate notes, a reviewer kept or rejected each.',
        {
            'sessions': 'consolidated: sent to the model',
            'skipped': f'fewer than {settings.MIN_TOOL_CALLS} tool calls, too short to learn from',
            'paused': 'ran while learning was paused for the repository (memorq.py pause on): never learnt from',
            'errors': 'the model call failed (no key, rate limit, no JSON back)',
            'candidates': 'notes the model proposed, before review',
            'accepted': 'kept by the reviewer and written as notes',
            'harness': 'rejected: about the run tooling or the agent, not the repository',
            'vague': 'rejected: no concrete command, path, check or condition',
            'duplicate': 'rejected: an existing note already says it',
            'task_state': 'rejected: what this session did, not a reusable fact',
            'derivable': 'rejected: one read of the code, README or git history shows it',
            'unsupported': 'rejected: the cited evidence does not support it',
            'sensitive': 'rejected: credentials, personal data or long code',
        },
    ),
    'Retrieval': (
        'Does the agent find the right note when it needs it? Whether sessions open the notes, whether the agent can see them at session start, and which ones it opens. Click a row to see its'
        ' notes.',
        {
            'sessions': 'sessions consolidated',
            'read ≥1 note': 'opened at least one note file',
            'failed reads': 'note reads that returned an error; recorded from 0.5.0 on',
            'full line': f'listed with title, trigger and age, while the list fits {settings.INDEX_FULL_CHARS:,} characters',
            'name only': f'listed by file name only, up to {settings.INDEX_CHARS:,} characters',
            'unlisted': 'not listed: found only if the agent searches the notes folder',
            '≤7 days ago': 'last opened this week: in use',
            '30+ days ago': 'not opened in a month: a candidate to merge or delete',
        },
    ),
    'Adherence': (
        'Does the agent do what its notes say? In production only proxies are visible, so read these as alarms. The offline benchmark measures it directly: with a note on the rule the agent avoided 17 of 26 known'
        ' mistakes, against 7 without (memorq plugin eval, set D).',
        {
            'read → corrected': 'sessions that read a note and still got a correction from the user',
            'repeated corrections': 'a correction the reviewer rejected as a duplicate: memory already had it',
        },
    ),
    'Hygiene': (
        'Is the store accurate, focused and easy to find things in? Notes by kind and age, and what keeps the store'
        ' tidy or shows it is not. Click a row to see its notes.',
        {
            'look-alike notes': f'share most of their words with another note (overlap {collect.LOOKALIKE:.0%} or more):'
            ' possible duplicates',
            'flagged to verify': 'the dream found them possibly wrong, e.g. contradicting AGENTS.md',
            'hand-edited': 'changed by a person since they were written',
            'superseded': 'replaced by a newer note, kept in superseded/',
            'duplicates blocked': 'candidates the reviewer rejected because a note already said it',
        },
    ),
    'Generalization': (
        'Do single cases become lasting lessons? The dream merges a lesson seen in two or more sessions into a rule, and a repeated procedure into a skill. Sightings: how many sessions a note was seen'
        ' in. Click a rule (or the rules step) to find it in the table.',
        {
            'rules of all notes': 'how much of the store is general lessons, not single cases',
            'corrections lost as vague': 'user corrections the reviewer rejected as too vague: often the general lesson',
            'folded by the dream': 'single-case notes a rule replaced',
            'ready': f'the next dream runs at a session start: {settings.DREAM_SESSIONS}+ sessions since the last one,'
            f' {settings.DREAM_MIN_NOTES}+ notes, a day since the last attempt',
        },
    ),
    'Is the factory learning?': (
        'What the writer proposed each week, as the reviewer judged it. The already-known share rising means sessions'
        ' keep meeting lessons memory has: the factory has learned that ground.',
        {
            'already known': 'rejected as a duplicate of a note memory already had',
            'new lesson kept': 'accepted and written as a note',
            'not a lesson': 'rejected for any other reason (vague, task state, derivable, …); counted beside the bar, which covers only the lessons judged real',
            'distilled': 'what the dream made of the notes that week: rules and skills',
        },
    ),
    'Has the learning been useful?': (
        'Mistakes per 100 sessions, split into new ones (now lessons) and repeated ones memory already had a lesson'
        ' for. Repeated staying near zero while recall rises is the production evidence that memory works.',
        {
            'new mistake': 'a user correction the reviewer accepted as a new lesson',
            'repeated': 'a user correction the reviewer rejected as a duplicate: memory had it',
            'recalled a note': 'share of sessions that opened at least one note',
        },
    ),
    'Week by week': (
        'The sessions of each calendar week, newest first, so a change to the prompts, the reviewer or the triggers'
        ' shows up as a change from one week to the next.',
        {
            'Kept': 'share of candidate notes the reviewer accepted that week',
            'Read a note': 'sessions that opened at least one note, out of sessions consolidated',
            'Repeated corrections': 'corrections the store already had a note for: memory did not prevent them',
        },
    ),
    'Repositories': (
        'One row per repository, most notes first. Click a name for its own cards: they describe one repository,'
        ' so they are not summed here.',
        {
            'Failed': 'sessions whose model call failed; they wrote no notes',
            'Already known': 'of the lessons the reviewer judged real, the share memory already had; a repository climbing here is converging',
            'Next dream': 'ready, waiting, error or off',
            'Attention': "what the repository's Needs attention list holds",
        },
    ),
    'Needs attention': (
        'What to look at in this store, most serious first. Click an item with a matching filter to list its notes.',
        {'error': 'something failed', 'warn': 'likely a problem', 'info': 'worth a look'},
    ),
    'Notes': (
        'Every note, most read first. Click a title for its trigger, body, the sessions that read it and the reviewer'
        ' reason.',
        {'live': 'read at least once', 'unread': 'never read', 'verify': 'flagged by the dream to check'},
    ),
}
