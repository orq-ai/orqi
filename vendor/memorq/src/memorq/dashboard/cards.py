"""One repository's section of the dashboard: Needs attention, the KPIs, the five cards and the notes table.

`section` only composes; each card is one function over the collected dicts. Never reads a store.
"""

from __future__ import annotations

import collections
import time
from typing import TYPE_CHECKING

from .. import settings
from . import attention, collect, parts, text

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from .data import AnyNote, Promotion, PromotionTotals, Skill, StoreView, TotalsView, View, Week

__all__ = [
    'ATTN_OPEN_MAX',
    'REJECT_TOP',
    'TREND_MIN_WEEKS',
    'YOUNG_SESSIONS',
    'learning',
    'learning_verdict',
    'overview',
    'section',
    'useful',
    'useful_verdict',
]

ATTN_OPEN_MAX = 3  # a longer Needs attention list starts collapsed, unless it holds an error
YOUNG_SESSIONS = 5  # below this many consolidated sessions a store gets one sentence instead of the KPI row
TREND_MIN_WEEKS = 3  # the week-by-week table shows once the sessions span this many calendar weeks
REJECT_TOP = 4  # rejection reasons shown by name; the rest are summed as "other"
NO_SESSION = parts.empty('Nothing to show until a session is consolidated.')


def section(s: View, anchor: str, with_store_column: bool, problems: list[attention.Problem]) -> str:  # noqa: FBT001
    """One repository's section (or the All repositories one, `with_store_column`), hidden until it is picked."""
    last = '' if with_store_column else f'<p class="meta">last update {parts.esc(parts.stamp(s["last_update"]))}</p>'
    cards = '\n'.join((_weeks(s), _writing(s), _generalization(s), _retrieval(s), _hygiene(s), _adherence(s)))
    young = s['funnel']['sessions'] < YOUNG_SESSIONS and 'states' not in s['promotion']
    return (
        f'\n<section id="{parts.esc(anchor)}">\n'
        f'<h2>{parts.esc(parts.repo_name(s["key"]))}</h2>{last}\n'
        f'{_attention(problems)}\n{learning(s)}\n{useful(s)}\n'
        + (_young(s) if young else f'<div class="kpis">{_kpis(s)}</div>')
        + f'\n<div class="grid">\n{cards}\n</div>\n'
        f'{_notes_table(s["notes"], with_store_column)}\n'
        '</section>'
    )


def overview(s: TotalsView, stores: list[StoreView], problems: dict[str, list[attention.Problem]]) -> str:
    """The All repositories section: every repository's errors, the sums that add up, one row per repository.

    The cards stay per repository: a ladder, a sightings histogram or a top 5 pooled over unrelated repositories
    describes none of them. The notes table here lists every note once, without its body: the body is in the
    repository's own table, and twice over it was most of the page.
    """
    items, said = [], set()
    for k, ps in problems.items():
        for lvl, msg, fix, _ in ps:
            if lvl == 'error':
                shown = '' if fix in said else f' <span>{parts.esc(fix)}</span>'  # the same advice once, not per repo
                said.add(fix)
                items.append(
                    f'<li class="lv-error"><a href="#{parts.esc(k)}"><b>{parts.esc(parts.repo_name(k))}</b></a>'
                    f' <b>{parts.esc(msg)}</b>{shown}</li>'
                )
    errors = ''.join(items)
    attn = (
        f'<div class="attn">{parts.heading("Needs attention")}<ul>{errors}</ul>'
        '<p class="meta">Warnings and info are counted per repository in the table below.</p></div>'
        if errors
        else ''
    )
    return (
        '\n<section id="all">\n'
        f'<h2>{parts.esc(s["key"])}</h2>\n{attn}\n'
        + (_young(s) if not s['funnel']['sessions'] else f'{learning(s)}\n{useful(s)}')
        + f'\n<div class="grid">\n{_repositories(stores, problems)}\n{_weeks(s)}\n</div>\n'
        f'{_notes_table(s["notes"], with_store_column=True, light=True)}\n'
        '</section>'
    )


def _repositories(stores: list[StoreView], problems: dict[str, list[attention.Problem]]) -> str:
    """One row per repository, each a link to its section: the comparison the sums cannot make."""
    rows = []
    for st in stores:
        f, r, p = st['funnel'], st['reading'], st['promotion']
        counts = collections.Counter(lvl for lvl, *_ in problems.get(st['key'], []))
        attn = _level_counts(counts)
        kept = _kept(f['accepted'], f['candidates'])
        known, judged = sum(w['known'] for w in st['weeks']), sum(w['known'] + w['accepted'] for w in st['weeks'])
        rows.append(
            f'<tr><td><a href="#{parts.esc(st["key"])}">{parts.esc(parts.repo_name(st["key"]))}</a></td>'
            f'<td class="n">{f["sessions"]}</td><td class="n" data-s="{f["errors"]}">{f["errors"] or ""}</td>'
            f'<td class="n">{len(st["notes"])}</td>'
            f'<td class="n" data-s="{_share(f["accepted"], f["candidates"])}">{kept}</td>'
            f'<td class="n" data-s="{_share(known, judged)}">{_kept(known, judged)}</td>'
            f'<td class="n" data-s="{_share(r["sessions_reading"], f["sessions"])}">{r["sessions_reading"]} / {f["sessions"]}</td>'
            f'<td class="n" data-s="{f["corrections_repeated"]}">{f["corrections_repeated"] or ""}</td>'
            f'<td class="n" data-s="{f["cost"]}">${f["cost"]:.2f}</td><td>{parts.pill(p["state"], p["state"])}</td>'
            f'<td class="counts" data-s="{10000 * counts["error"] + 100 * counts["warn"] + counts["info"]}">'
            f'{attn or "—"}</td></tr>'
        )
    head = parts.head_row(
        (
            'Repository',
            'Sessions',
            'Failed',
            'Notes',
            'Kept',
            'Already known',
            'Read a note',
            'Repeated corrections',
            'Cost',
            'Next dream',
            'Attention',
        ),
        numeric=('Sessions', 'Failed', 'Notes', 'Kept', 'Already known', 'Read a note', 'Repeated corrections', 'Cost'),
    )
    return (
        f'<div class="card wide">{parts.heading("Repositories")}'
        f'<div class="tbl"><table>{head}{"".join(rows)}</table></div></div>'
    )


def _known_share(w: Week) -> int | None:
    """Of the lessons a week proposed and the reviewer judged a lesson, the percent memory already had; None when none."""
    judged = w['accepted'] + w['known']
    return 100 * w['known'] // judged if judged else None


def _pct(v: int | None) -> str:
    """A share as `24%`, or a dash when there was nothing to take a share of."""
    return '—' if v is None else f'{v}%'


def _ends(weeks: list[Week], share: Callable[[Week], int | None]) -> list[Week]:
    """The weeks a verdict can compare: those with a defined `share`, so a dream-only week is never an endpoint."""
    return [w for w in weeks if share(w) is not None]


def learning_verdict(weeks: list[Week]) -> str:
    """One sentence on whether the factory is learning: the already-known share, first week against last."""
    if not weeks:
        return ''
    ends = _ends(weeks, _known_share) or weeks
    k0, k1 = _known_share(ends[0]), _known_share(ends[-1])
    tail = (
        f'{text.plural(sum(w["accepted"] for w in weeks), "lesson")} learned,'
        f' {text.plural(sum(w["rules"] for w in weeks), "rule")} and'
        f' {text.plural(sum(w["skills"] for w in weeks), "skill")} distilled.'
    )
    if len(ends) == 1:
        return f'First week: {_pct(k0)} of proposed lessons were already known. {tail}'
    if k0 is None or k1 is None:  # cannot happen: both ends have a share, or there is one end
        return ''
    if k1 > k0:
        verb = 'Converging'
    elif k1 == k0:
        verb = 'Holding'
    else:
        verb = 'Still new ground'
    return f'{verb}: {_pct(k0)} of proposed lessons were already known in the first week, {_pct(k1)} last week. {tail}'


def learning(s: View) -> str:
    """The "Is the factory learning?" card: verdict, one stacked row per week, what the dream distilled."""
    weeks = s['weeks']
    if not s['funnel']['sessions'] or not weeks:
        return ''
    rows: list[parts.Row] = []
    for i in range(len(weeks) - 1, -1, -1):  # newest first
        w = weeks[i]
        k = _known_share(w)
        prev = _known_share(weeks[i - 1]) if i else None
        chip = parts.chip(k - prev) if k is not None and prev is not None else ''
        value = f'{_pct(k)} already known · {w["noise"]} not a lesson' + (f' {chip}' if chip else '')
        rows.append((
            f'week of {w["week"][5:]}',
            text.plural(w['sessions'], 'session'),
            [
                ('deep', w['known'], f'{w["known"]} already known: memory had the lesson'),
                ('good', w['accepted'], f'{text.plural(w["accepted"], "new lesson")} kept'),
            ],
            value,
        ))
    legend = (
        '<p class="legend"><i class="s-deep"></i>already known: memory had the lesson'
        ' <i class="s-good"></i>new lesson kept</p>'
    )
    distilled = ''.join(
        f'<tr><td>{w["week"]}</td><td class="n">{w["accepted"]}</td><td class="n">{w["rules"]}</td>'
        f'<td class="n">{w["skills"]}</td></tr>'
        for w in reversed(weeks)
    )
    head = parts.head_row(('Week of', 'notes', '→ rules', '→ skills'), numeric=('notes', '→ rules', '→ skills'))
    return (
        f'<div class="card wide">{parts.heading("Is the factory learning?")}'
        f'<p class="verdict">{parts.esc(learning_verdict(weeks))}</p>{legend}{parts.stacks(rows, share=True)}'
        f'<div class="side"><h4>Distilled by the dream</h4><table>{head}{distilled}</table></div>'
        '<p class="note">"Already known" is the reviewer\'s verdict, so it is as good as the reviewer.</p></div>'
    )


def _recall_share(w: Week) -> int | None:
    """The percent of a week's sessions that opened a note; None when the week had no session."""
    return 100 * w['reading'] // w['sessions'] if w['sessions'] else None


NO_CORRECTIONS = 'No user corrections logged yet, so nothing to measure against.'
USEFUL_NOTE = (
    'A mistake is a user correcting the agent. A repeated one is a mistake memory already had a lesson for: memory'
    ' was not recalled, or was recalled and not followed. This measures the human-in-the-loop factory; an autonomous'
    ' one needs reviewer or eval verdicts as the signal. The direct measure is the offline benchmark: with a note on'
    ' the rule the agent avoided 17 of 26 known mistakes, against 7 without.'
)


def useful_verdict(weeks: list[Week]) -> str:
    """One sentence on whether the learning helped: repeated mistakes against recall, first week to last."""
    if not weeks:
        return ''
    corrections, repeated = sum(w['corrections'] for w in weeks), sum(w['repeated'] for w in weeks)
    if not corrections:
        return NO_CORRECTIONS
    head = (
        f'Early evidence: {repeated} of {text.plural(corrections, "mistake")} were ones memory already had a lesson for'
    )
    ends = _ends(weeks, _recall_share) or weeks
    r0, r1 = _recall_share(ends[0]), _recall_share(ends[-1])
    if len(ends) == 1:
        return f'{head}; {_pct(r0)} of sessions recalled a note.'
    return f'{head}, while sessions recalling a note went from {_pct(r0)} to {_pct(r1)}.'


def useful(s: View) -> str:
    """The "Has the learning been useful?" card: verdict, mistakes per week, the lessons that did and did not stick."""
    weeks = s['weeks']
    if not s['funnel']['sessions'] or not weeks:
        return ''
    verdict = useful_verdict(weeks)
    recalled = ''.join(
        f'<li><b>{parts.esc(title)}</b><span>recalled in {text.plural(n, "session")}</span></li>'
        for _, title, n in s['reading']['top']
    ) or parts.empty('None yet.', 'Each session opens a note when its trigger matches the task.')
    recalled_block = (
        '<div><h4>Lessons recalled most</h4><p class="hint">Opened by later sessions, and not corrected again.</p>'
        f'<ul>{recalled}</ul></div>'
    )
    if verdict == NO_CORRECTIONS:
        return (
            f'<div class="card wide">{parts.heading("Has the learning been useful?")}'
            f'<p class="verdict">{parts.esc(verdict)}</p><div class="two">{recalled_block}</div>'
            f'<p class="note">{parts.esc(USEFUL_NOTE)}</p></div>'
        )
    rows: list[parts.Row] = []
    for w in reversed(weeks):  # newest first
        total = round(100 * w['corrections'] / w['sessions']) if w['sessions'] else 0
        rep_ = round(100 * w['repeated'] / w['sessions']) if w['sessions'] else 0
        value = f'{total} per 100 sessions' + (f' · {w["repeated"]} repeated' if w['repeated'] else '')
        rows.append((
            f'week of {w["week"][5:]}',
            f'recalled a note in {_pct(_recall_share(w))}',
            [
                (
                    'pt',
                    total - rep_,
                    f'{w["corrections"] - w["repeated"]} new mistakes in {text.plural(w["sessions"], "session")}',
                ),
                ('bad', rep_, f'{w["repeated"]} repeated mistakes memory already had a lesson for'),
            ],
            value,
        ))
    legend = (
        '<p class="legend"><i class="s-bad"></i>repeated: memory already had the lesson'
        ' <i class="s-pt"></i>new mistake, now a lesson</p>'
    )
    missed = s['missed']
    missed_items = ''.join(
        f'<li><b>{parts.esc(m["title"])}</b><span>'
        f'{parts.esc(parts.repo_name(m["store"])) if "store" in m else parts.esc(parts.stamp(m["ts"])[:10])}</span></li>'
        for m in missed
    ) or parts.empty('None yet.')
    missed_block = (
        f'<div><h4>Lessons that did not stick <em>{len(missed)}</em></h4>'
        '<p class="hint">A session was corrected for something memory already had a note on.</p>'
        f'<ul>{missed_items}</ul></div>'
    )
    return (
        f'<div class="card wide">{parts.heading("Has the learning been useful?")}'
        f'<p class="verdict">{parts.esc(verdict)}</p>{legend}{parts.stacks(rows, share=False)}'
        f'<div class="two">{missed_block}{recalled_block}</div>'
        f'<p class="note">{parts.esc(USEFUL_NOTE)}</p></div>'
    )


def _young(s: View) -> str:
    """A young store's one sentence: what its sessions produced and what happens next, instead of six KPIs."""
    f, p = s['funnel'], s['promotion']
    if not f['sessions']:
        done = 'No session learned from yet'
    else:
        done = (
            f'{text.plural(f["sessions"], "session")} learned from → {text.plural(f["candidates"], "candidate")}'
            f' → {text.plural(f["accepted"], "note")} kept'
        )
    listed = ' · listed at the start of your next session' if s['notes'] else ''
    dream = f' · first dream after {text.plural(settings.DREAM_SESSIONS, "session")}' if not p['last_dream'] else ''
    cost = f' · ${f["cost"]:.2f}' if f['cost'] else ''
    return f'<p class="young">{parts.esc(done + listed + dream + cost)}</p>'


def _weeks(s: View) -> str:
    """Week by week, newest first, once the sessions span TREND_MIN_WEEKS calendar weeks; nothing before."""
    if len(s['weeks']) < TREND_MIN_WEEKS:
        return ''
    rows = ''.join(
        f'<tr><td>{w["week"]}</td><td class="n">{w["sessions"]}</td><td class="n" data-s="{w["errors"]}">{w["errors"] or ""}</td>'
        f'<td class="n" data-s="{_share(w["accepted"], w["candidates"])}">{_kept(w["accepted"], w["candidates"])}</td>'
        f'<td class="n" data-s="{_share(w["reading"], w["sessions"])}">{w["reading"]} / {w["sessions"]}</td>'
        f'<td class="n" data-s="{w["repeated"]}">{w["repeated"] or ""}</td>'
        f'<td class="n" data-s="{w["cost"]}">${w["cost"]:.2f}</td></tr>'
        for w in reversed(s['weeks'])
    )
    head = parts.head_row(
        ('Week of', 'Sessions', 'Failed', 'Kept', 'Read a note', 'Repeated corrections', 'Cost'),
        numeric=('Sessions', 'Failed', 'Kept', 'Read a note', 'Repeated corrections', 'Cost'),
    )
    return (
        f'<div class="card wide">{parts.heading("Week by week")}'
        f'<div class="tbl"><table>{head}{rows}</table></div></div>'
    )


def _attention(problems: list[attention.Problem]) -> str:
    if not problems:
        return '<div class="attn"><p class="calm">Nothing needs attention.</p></div>'
    items = ''.join(
        (
            f'<li class="lv-{lvl}"><button type="button"{parts.pick(*pick)}><b>{parts.esc(msg)}</b>'
            f' <span>{parts.esc(fix)}</span></button></li>'
            if pick
            else f'<li class="lv-{lvl}"><b>{parts.esc(msg)}</b> <span>{parts.esc(fix)}</span></li>'
        )
        for lvl, msg, fix, pick in sorted(problems, key=lambda x: attention.LEVELS.index(x[0]))
    )
    counts = collections.Counter(lvl for lvl, *_ in problems)
    summary = _level_counts(counts)
    # ponytail: native <details>, no script; closed when the list is long, never while it holds an error
    state = '' if len(problems) > ATTN_OPEN_MAX and not counts['error'] else ' open'
    return (
        f'<details class="attn"{state}><summary>{parts.heading("Needs attention")}'
        f'<span class="counts">{summary}</span></summary><ul>{items}</ul></details>'
    )


def _level_counts(counts: collections.Counter[str]) -> str:
    """`1 error · 2 warnings`, each in its level's colour."""
    names = {'error': ('error', 'errors'), 'warn': ('warning', 'warnings'), 'info': ('info', 'info')}
    return ' · '.join(
        f'<span class="lv-{lvl}">{counts[lvl]} {names[lvl][counts[lvl] != 1]}</span>'
        for lvl in attention.LEVELS
        if counts[lvl]
    )


def _share(part: int, whole: int) -> str:
    """A sort key for `part / whole`: the ratio, or -1 when there is no whole, so empty rows sort last."""
    return f'{part / whole:.4f}' if whole else '-1'


def _kept(accepted: int, candidates: int) -> str:
    """The share of candidates the reviewer kept, or a dash before there were any."""
    return f'{100 * accepted // candidates}%' if candidates else '—'


def _kpis(s: View) -> str:
    f, r, p, notes = s['funnel'], s['reading'], s['promotion'], s['notes']
    kept = _kept(f['accepted'], f['candidates'])
    per_session = f'${f["cost"] / f["sessions"]:.2f}/session' if f['sessions'] else ''
    # a note is unread until a later session needs it: no alarm on a young store (attention.py's guard too)
    never_cls = ' class="warn"' if notes and f['sessions'] >= 3 and r['never_read'] / len(notes) > 0.5 else ''
    ready_text = f'{text.plural(p["ready"], "store")} ready' if 'states' in p else f'next dream: {p["state"]}'
    promoted = f'{text.plural(p["rules"], "rule")}, {text.plural(p["skills"], "skill")} · {ready_text}'
    kpis = [
        ('notes', str(len(notes)), f'{len(s["kinds"])} kinds', 'Notes in the store now.'),
        (
            'kept',
            kept,
            f'{f["accepted"]} of {f["candidates"]} candidates',
            'Share of proposed notes the reviewer accepted.',
        ),
        (
            'sessions that read a note',
            f'{r["sessions_reading"]} / {f["sessions"]}',
            '',
            'Sessions that opened at least one note, out of sessions consolidated.',
        ),
        (
            'never read',
            f'<span{never_cls}>{r["never_read"]} / {len(notes)}</span>',
            '',
            'Notes no session has opened yet. Orange when more than half, after three sessions.',
        ),
        (
            'promoted',
            str(p['rules'] + p['skills']),
            promoted,
            'Promoted by the dream pass. The Generalization card says when the next dream runs.',
        ),
        ('cost', f'${f["cost"]:.2f}', per_session or 'writing cost', 'Model cost of writing and reviewing notes.'),
    ]
    more = f'<button type="button" class="more"{parts.pick("unread", "1", "never read")}>list them</button>'
    return ''.join(
        f'<div class="kpi"><span class="label">{parts.esc(label)}</span><b>{value}</b>'
        + (f'<small>{parts.esc(unit)}</small>' if unit else '')
        + parts.info(label, parts.esc(tip))
        + (more if label == 'never read' and r['never_read'] else '')
        + '</div>'
        for label, value, unit, tip in kpis
    )


def _writing(s: View) -> str:
    f = s['funnel']
    if f['sessions'] or f['skipped'] or f['paused'] or f['errors']:
        paused = [('paused', f['paused'])] if f['paused'] else []  # a row only for a store that was ever paused
        steps = [('sessions', f['sessions']), ('skipped', f['skipped']), *paused, ('errors', f['errors'])]
        funnel = (
            parts.bars([*steps, ('candidates', f['candidates'])], max(f['candidates'], f['sessions']))
            + parts.bars([('accepted', f['accepted'])], max(f['candidates'], 1), 'good')
            + '<h4>Rejected, by reason</h4>'
            + (
                # grey, not orange: a rejection is the reviewer doing its job
                parts.bars(_top(f['rejected'], REJECT_TOP), max(f['rejected'].values(), default=1))
                or parts.empty('Nothing rejected yet.')
            )
        )
    else:
        funnel = parts.empty(
            'No session consolidated yet.',
            f'A session with {settings.MIN_TOOL_CALLS} or more tool calls becomes candidate notes when it ends.',
        )
    return f'<div class="card">{parts.heading("Writing")}\n{funnel}\n</div>'


def _top(counts: dict[str, int], n: int) -> list[tuple[str, int]]:
    """The `n` largest counts by name, and the rest summed as `other`."""
    items = sorted(counts.items(), key=lambda kv: -kv[1])
    rest = sum(v for _, v in items[n:])
    return items[:n] + ([('other', rest)] if rest else [])


def _generalization(s: View) -> str:
    f, p, notes = s['funnel'], s['promotion'], s['notes']
    rules = (
        (
            f'<button type="button" class="step"{parts.pick("kind", "rule", "rules")}>'
            if p['rules']
            else '<div class="step">'
        )
        + f'<b>{p["rules"]}</b>{"rule" if p["rules"] == 1 else "rules"}'
        + ('</button>' if p['rules'] else '</div>')
    )
    ladder = (
        f'<div class="ladder"><div class="step"><b>{len(notes)}</b>notes</div><span class="arrow">→</span>{rules}'
        f'<span class="arrow">→</span><div class="step"><b>{p["skills"]}</b>{"skill" if p["skills"] == 1 else "skills"}'
        '</div><span class="arrow">→</span><div class="step"><b>0</b>checks</div></div>'
    )
    rules_share = f'{100 * p["rules"] // len(notes)}%' if notes else '—'
    sightings = parts.bars(
        [('3+ sessions' if k == '3+' else text.plural(int(k), 'session'), v) for k, v in p['sightings'].items()],
        max(p['sightings'].values(), default=1),
        field='seen',
        values=list(p['sightings']),
    )
    return (
        f'<div class="card">{parts.heading("Generalization")}\n{ladder}\n'
        f'<p class="meta">rules of all notes {rules_share} · corrections lost as vague {f["corrections_vague"]}'
        f' of {f["corrections"]} · folded by the dream {p["folded"]}</p>\n'
        f'<h4>Sightings</h4>{sightings}\n{_promoted(notes, s["skills"])}\n{_dream_status(p)}\n</div>'
    )


def _promoted(notes: Sequence[AnyNote], skills: list[Skill]) -> str:
    """The rules and skills the dream promoted: rules filter the table, skills show their file."""
    rules = sorted((n for n in notes if n['kind'] == 'rule'), key=lambda n: -n['sightings'])
    rule_items = ''.join(
        f'<li><button type="button"{parts.pick("name", n["name"], n["title"])}>{parts.esc(n["title"])}'
        f' <em class="meta">· seen in {n["sightings"]} sessions</em></button></li>'
        for n in rules
    )
    none = f'<li>{parts.empty("None yet.")}</li>'
    skill_items = ''.join(
        f'<li><details><summary>{parts.esc(sk["name"])} <em class="meta">· seen in {sk["sightings"]} sessions</em>'
        f'</summary><div>{parts.esc(sk["description"])}<br><code>{parts.esc(sk["path"])}</code></div></details></li>'
        for sk in skills
    )
    return (
        f'<h4>Rules</h4><ul class="top">{rule_items or none}</ul>'
        f'<h4>Skills</h4><ul class="top">{skill_items or none}</ul>'
    )


def _dream_status(p: Promotion | PromotionTotals) -> str:
    """Why the next dream will or won't run, and what the last one did."""
    if 'states' in p:  # the All repositories view
        states = ' · '.join(f'{n} {state}' for state, n in p['states'].items())
        return f'<p class="meta">next dream, by repository: {parts.esc(states)}</p>'
    idle_h = settings.DREAM_IDLE_S // 3600
    since_h = (time.time() - p['last_attempt']) / 3600 if p['last_attempt'] else None
    checks = [
        (
            p['sessions_since_dream'] >= settings.DREAM_SESSIONS,
            f'{text.plural(p["sessions_since_dream"], "session")} since the last dream (needs {settings.DREAM_SESSIONS})',
        ),
        (p['notes'] >= settings.DREAM_MIN_NOTES, f'{p["notes"]} notes (needs {settings.DREAM_MIN_NOTES})'),
        (
            since_h is None or since_h >= idle_h,
            'no attempt yet' if since_h is None else f'last attempt {since_h:.0f}h ago (needs {idle_h}h)',
        ),
    ]
    items = ''.join(
        f'<li class="{"ok" if ok else "no"}">{"✓" if ok else "·"} {parts.esc(label)}</li>' for ok, label in checks
    )
    res = p['last_result']
    if not res:
        last = (
            f'No dream yet: it runs every {settings.DREAM_SESSIONS} sessions, at most once a day, once the store has'
            f' {settings.DREAM_MIN_NOTES} notes.'
        )
    elif res['error']:
        last = f'Last dream {parts.stamp(p["last_dream"])}: failed.'
    else:
        last = (
            f'Last dream {parts.stamp(p["last_dream"])}: {res["written"]} rules, {res["skills"]} skills,'
            f' {res["retired"]} retired, {res["superseded"]} merged.'
        )
    return (
        f'<p class="dream">{parts.pill(p["state"], p["state"])} next dream</p>'
        f'<ul class="checks">{items}</ul><p class="meta">{parts.esc(last)}</p>'
    )


def _retrieval(s: View) -> str:
    f, r, tiers, n = s['funnel'], s['reading'], s['index_tiers'], max(len(s['notes']), 1)
    reading = (
        parts.bars(
            [('sessions', f['sessions']), ('read ≥1 note', r['sessions_reading']), ('failed reads', r['failed_reads'])],
            max(f['sessions'], 1),
        )
        if f['sessions']
        else NO_SESSION
    )
    listed = parts.bars(
        [('full line', tiers['full']), ('name only', tiers['names']), ('unlisted', tiers['unlisted'])],
        n,
        field='tier',
        values=['full', 'names', 'unlisted'],
    )
    top = ''.join(
        f'<li><button type="button"{parts.pick("name", t[0], t[1])}>{parts.esc(t[1])} <em class="meta">· {t[2]}</em>'
        '</button></li>'
        for t in r['top']
    ) or (
        '<li>'
        + parts.empty(
            'No note opened yet.',
            'Each session starts with the list of notes and opens one when its trigger matches the task.',
        )
        + '</li>'
    )
    heat = r['heat']
    opened = parts.bars(
        [
            ('≤7 days ago', heat['hot']),
            ('8-30 days ago', heat['warm']),
            ('30+ days ago', heat['cold']),
            ('never', heat['never']),
        ],
        n,
        field='heat',
        values=['hot', 'warm', 'cold', 'never'],
    )
    return (
        f'<div class="card">{parts.heading("Retrieval")}\n{reading}\n<h4>Session-start list</h4>{listed}\n'
        f'<h4>Most read</h4><ul class="top">{top}</ul>\n<h4>Last opened</h4>{opened}\n</div>'
    )


def _hygiene(s: View) -> str:
    notes, kinds, ages = s['notes'], s['kinds'], s['ages']
    tidiness = [
        ('look-alike notes', sum(1 for n in notes if n.get('twin')), 'twin'),
        ('flagged to verify', sum(1 for n in notes if n['verify']), 'verify'),
        ('hand-edited', sum(1 for n in notes if n['human_edited']), 'edited'),
    ]
    tidy = ''.join(
        parts.bars([(label, v)], max(len(notes), 1), field=field, values=['1']).replace(f'{field}: {label}', label)
        for label, v, field in tidiness
    )
    by_kind = parts.bars(list(kinds.items()), max(kinds.values(), default=1), field='kind')
    by_age = parts.bars(
        [(f'{k} days', v) for k, v in ages.items()], max(ages.values(), default=1), field='age', values=list(ages)
    )
    blocked = s['funnel']['rejected'].get('duplicate', 0)
    return (
        f'<div class="card">{parts.heading("Hygiene")}\n{by_kind}\n<h4>Age</h4>{by_age}\n<h4>Tidiness</h4>{tidy}\n'
        f'<p class="meta">superseded {s["superseded"]} · duplicates blocked by the reviewer {blocked}</p>\n</div>'
    )


def _adherence(s: View) -> str:
    f, r = s['funnel'], s['reading']
    adherence = (
        parts.bars(
            [('read → corrected', r['read_then_corrected']), ('repeated corrections', f['corrections_repeated'])],
            max(f['sessions'], 1),
            'bad',
        )
        if f['sessions']
        else NO_SESSION
    )
    return f'<div class="card wide">{parts.heading("Adherence")}\n{adherence}\n</div>'


def _notes_table(notes: Sequence[AnyNote], with_store_column: bool, light: bool = False) -> str:  # noqa: FBT001, FBT002
    """Every note, most read first; `light` rows (the All view) carry no body, no filters and fewer columns."""
    ordered = sorted(notes, key=lambda n: (-n['reads'], n['age']))
    rows = ''.join(_light_row(n) if light else _note_row(n) for n in ordered)
    columns = (
        ('Note', 'Kind', 'Age', 'Reads') if light else ('Note', 'Kind', 'Age', 'Reads', 'Last read', 'Seen', 'Status')
    )
    head = parts.head_row(
        (('Repository',) if with_store_column else ()) + columns,
        numeric=('Age', 'Reads', 'Seen'),
    )
    empty = f'<tr><td colspan="9">{parts.empty("No notes yet.", "They are written when a session ends.")}</td></tr>'
    return (
        f'{parts.heading("Notes", "margin-top:24px")}\n'
        '<p class="filter" hidden><span></span> <button type="button" data-clear>show all</button></p>\n'
        f'<div class="tbl"><table>{head}{rows or empty}</table></div>'
    )


def _light_row(n: AnyNote) -> str:
    store_td = f'<td>{parts.esc(parts.repo_name(n["store"]))}</td>' if 'store' in n else ''
    return (
        f'<tr data-name="{parts.esc(n["name"])}">{store_td}<td>{parts.esc(n["title"])}</td>'
        f'<td>{parts.esc(n["kind"])}</td><td class="n" data-s="{n["age"]}">{n["age"]}d</td>'
        f'<td class="n">{n["reads"]}</td></tr>'
    )


def _note_row(n: AnyNote) -> str:
    status = 'verify' if n['verify'] else 'live' if n['reads'] else 'unread'
    store_td = f'<td>{parts.esc(n["store"])}</td>' if 'store' in n else ''  # the All repositories view
    detail = (
        f'<div><b>Trigger:</b> {parts.esc(n["trigger"])}<br><b>Body:</b> {parts.esc(n["body"])}'
        f'{"<br><b>Read by:</b> " + parts.esc(", ".join(n["read_by"])) if n["read_by"] else ""}'
        f'{"<br><b>Reviewer:</b> " + parts.esc(n["reason"]) if n["reason"] else ""}'
        f'{"<br><b>Verify:</b> " + parts.esc(n["verify"]) if n["verify"] else ""}'
        f'{"<br><b>Edited by hand</b>" if n["human_edited"] else ""}</div>'
    )
    data = (
        f'data-name="{parts.esc(n["name"])}" data-kind="{parts.esc(n["kind"])}" data-age="{collect.bucket(n["age"])}"'
        f' data-seen="{"3+" if n["sightings"] >= 3 else n["sightings"]}" data-tier="{n["tier"]}"'
        f' data-unread="{0 if n["reads"] else 1}" data-heat="{n["heat"]}" data-verify="{1 if n["verify"] else 0}"'
        f' data-twin="{1 if n.get("twin") else 0}" data-edited="{1 if n["human_edited"] else 0}"'
    )
    return (
        f'<tr {data}>{store_td}<td><details><summary>{parts.esc(n["title"])}</summary>'
        f'{detail}</details></td><td>{parts.esc(n["kind"])}</td><td class="n" data-s="{n["age"]}">{n["age"]}d</td>'
        f'<td class="n">{n["reads"]}</td><td data-s="{parts.esc(n["last_read"])}">{parts.ago(n["last_read"])}</td>'
        f'<td class="n">{n["sightings"]}</td><td>{parts.pill(status, status)}</td></tr>'
    )
