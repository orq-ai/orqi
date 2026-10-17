"""Small HTML pieces the dashboard's cards and page share: escaping, the (i) tooltips, filter buttons, bars, dates."""

from __future__ import annotations

import html
from typing import Any

from . import collect, tips

__all__ = [
    'SERIES',
    'ago',
    'bars',
    'chip',
    'empty',
    'esc',
    'head_row',
    'heading',
    'info',
    'pick',
    'pill',
    'repo_name',
    'stacks',
    'stamp',
    'tip',
]


def esc(x: Any) -> str:
    """`x` as text, escaped for HTML content and attribute values."""
    return html.escape(str(x), quote=True)


def info(about: str, html_text: str) -> str:
    """An (i) that shows an explanation on hover or keyboard focus. `html_text` is already escaped."""
    return (
        f'<span class="info" tabindex="0" aria-label="About {esc(about)}">i'
        f'<span class="tip" role="tooltip">{html_text}</span></span>'
    )


def heading(title: str, style: str = '') -> str:
    """A card title with an (i) that shows the card's explanation (tips.HELP)."""
    summary, rows = tips.HELP[title]
    lines = ''.join(f'<br><b>{esc(k)}</b> {esc(v)}' for k, v in rows.items())
    attr = f' style="{style}"' if style else ''
    return f'<h3{attr}>{esc(title)}{info(title, esc(summary) + lines)}</h3>'


def head_row(labels: tuple[str, ...], numeric: tuple[str, ...] = ()) -> str:
    """A table's header row; each header is a button that sorts the table by its column (see page.js).

    Columns named in `numeric` are right-aligned (class `n`); their cells carry the same class.
    """
    cells = ''
    for h in labels:
        attr = ' class="n"' if h in numeric else ''
        cells += f'<th{attr}><button type="button" class="sort">{esc(h)}</button></th>'
    return f'<tr>{cells}</tr>'


PILL_KIND = {
    'ready': 'success',
    'live': 'success',
    'waiting': 'neutral',
    'unread': 'neutral',
    'off': 'neutral',
    'error': 'danger',
    'verify': 'danger',
    'warn': 'warning',
    'info': 'info',
}


def pill(state: str, text: str) -> str:
    """A state as the product's pill: success, warning, danger, info or neutral by `state` (PILL_KIND)."""
    return f'<span class="pill pill-{PILL_KIND.get(state, "neutral")}">{esc(text)}</span>'


def chip(delta: float, unit: str = 'pts') -> str:
    """A week-over-week change as the product's trend chip; nothing when there is no change."""
    if round(delta) == 0:
        return ''
    up = delta > 0
    return f'<span class="chip {"up" if up else "down"}">{"▲" if up else "▼"} {"+" if up else "-"}{abs(round(delta))} {esc(unit)}</span>'


def empty(title: str, text: str = '') -> str:
    """The product's empty state: a dashed box with a title and, optionally, what fills it."""
    return f'<div class="empty"><b>{esc(title)}</b>{f"<span>{esc(text)}</span>" if text else ""}</div>'


def repo_name(key: str) -> str:
    """A store key as people write the repository: `orq-ai__orqi` is `orq-ai/orqi`."""
    owner, _, repo = key.partition('__')
    return f'{owner}/{repo}' if repo else key


def stamp(ts: str) -> str:
    """A log timestamp as `YYYY-MM-DD HH:MM`, or `never`."""
    return ts.replace('T', ' ')[:16] or 'never'


def ago(ts: str) -> str:
    """How long ago a log timestamp was: `today`, `3d ago`, `never`, or `?`."""
    days = collect.days_since(ts) if ts else None
    return 'never' if not ts else '?' if days is None else 'today' if days == 0 else f'{days}d ago'


def pick(field: str, value: str, label: str) -> str:
    """Attributes that make an element filter the notes table on click (see page.js)."""
    return f' data-f="{field}" data-v="{esc(value)}" data-label="{esc(label)}"'


SERIES = (
    'good',
    'bad',
    'deep',
    'ctx',
    'pt',
)  # the chart series classes: .s-good is the product's teal, .s-bad its orange


def _series(cls: str) -> str:
    """A bar's class attribute: `s-<series>` for a named series, the default (grey) bar otherwise."""
    return f's-{cls}' if cls in SERIES else ''


def tip(text: str) -> str:
    """Attributes that give an element the page's tooltip on hover and keyboard focus (see page.js)."""
    return f' data-tip="{esc(text)}" aria-label="{esc(text)}" tabindex="0"'


def bars(
    items: list[tuple[str, int]], total: int, cls: str = '', field: str = '', values: list[str] | None = None
) -> str:
    """One bar per item; with `field`, a bar with notes behind it filters the table to them."""
    width = max(total, 1)
    values = values or [k for k, _ in items]
    klass = _series(cls)
    return ''.join(
        (
            f'<button type="button" class="bar"{pick(field, val, f"{field}: {k}")}>'
            if field and v
            else '<div class="bar">'
        )
        + f'<span>{esc(k)}</span><i class="{klass}" style="width:{min(100, 100 * v / width):.0f}%"></i><em>{v}</em>'
        + ('</button>' if field and v else '</div>')
        for (k, v), val in zip(items, values)
    )


Row = tuple[str, str, list[tuple[str, int, str]], str]  # label, sub-label, (series, amount, tooltip) segments, value


def stacks(rows: list[Row], share: bool) -> str:  # noqa: FBT001
    """Horizontal stacked bars, one row each: `share` rows fill the track; others scale to the busiest row."""
    busiest = max((sum(a for _, a, _ in segs) for _, _, segs, _ in rows), default=0)
    out = []
    for label, sub, segs, value in rows:
        total = sum(a for _, a, _ in segs)
        whole = total if share else busiest
        drawn = [(cls, a, t) for cls, a, t in segs if a > 0]
        widths = [round(100 * a / whole) for _, a, _ in drawn] if whole else []
        if share and widths:
            widths[-1] = 100 - sum(widths[:-1])  # rounding never overflows the track
        track = ''.join(
            f'<i class="{_series(cls)}" style="width:{w}%"{tip(t)}></i>' for (cls, _, t), w in zip(drawn, widths)
        )
        out.append(
            f'<div class="stack"><span class="lab">{esc(label)}<small>{esc(sub)}</small></span>'
            f'<div class="track">{track}</div><span class="val">{value}</span></div>'
        )
    return f'<div class="stacks">{"".join(out)}</div>'
