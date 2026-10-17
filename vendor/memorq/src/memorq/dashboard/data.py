"""The shapes of the dashboard's collected data: what `collect` returns and `attention`, `cards` and `render` read.

Plain dicts at runtime (TypedDicts), so the data stays JSON-like. A repository's view (`StoreView`) and the All
repositories view (`TotalsView`) share most keys; where they differ, the final classes let a `'key' in d` check tell
them apart for the type checker.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict, Union, final

if TYPE_CHECKING:
    from .. import stats

__all__ = [
    'AnyNote',
    'LastResult',
    'Missed',
    'Note',
    'Page',
    'Promotion',
    'PromotionTotals',
    'Reading',
    'Skill',
    'StoreView',
    'TotalsMissed',
    'TotalsNote',
    'TotalsView',
    'View',
    'Week',
]


class _NoteBase(TypedDict):
    name: str
    title: str
    trigger: str
    body: str
    kind: str
    created: str
    age: int  # days
    sightings: int
    verify: str  # why the dream flagged it, or ''
    human_edited: bool
    reads: int  # sessions that opened it
    read_by: list[str]
    reason: str  # the reviewer's, when it was accepted
    last_read: str
    heat: str  # hot, warm, cold, never
    tier: str  # full, names, unlisted: how the session-start index lists it
    twin: bool  # looks like another note


@final
class Note(_NoteBase):
    """A note in one repository's view."""


@final
class TotalsNote(_NoteBase):
    """A note in the All repositories view, tagged with its repository."""

    store: str


AnyNote = Union[Note, TotalsNote]


class Skill(TypedDict):
    name: str
    description: str
    sightings: int
    path: str


class Reading(TypedDict):
    sessions_reading: int
    failed_reads: int
    read_then_corrected: int
    never_read: int
    heat: dict[str, int]
    top: list[tuple[str, str, int]]  # name, title, reads


class LastResult(TypedDict):
    error: str
    written: int
    skills: int
    retired: int
    superseded: int


class _PromotionBase(TypedDict):
    rules: int
    skills: int
    sightings: dict[str, int]  # '1', '2', '3+' -> notes
    dreams: int
    folded: int
    last_dream: str
    sessions_since_dream: int


@final
class Promotion(_PromotionBase):
    """One repository's promotion ladder and next dream."""

    ready: bool
    state: str  # off, ready, error, waiting
    notes: int
    last_attempt: float
    last_result: LastResult | None


@final
class PromotionTotals(_PromotionBase):
    """The sums over every repository: how many are ready, and how many in each state."""

    ready: int
    states: dict[str, int]


class Week(TypedDict):
    """One calendar week of sessions, Monday first: the numbers that show whether a change made a difference."""

    week: str  # the Monday, YYYY-MM-DD
    sessions: int  # consolidated
    errors: int
    candidates: int
    accepted: int
    reading: int  # sessions that opened a note
    repeated: int  # corrections the store already had: mistakes made despite a lesson in memory
    cost: float
    known: int  # proposed lessons rejected as duplicates: memory already had them
    noise: int  # proposed lessons rejected for any other reason
    corrections: int  # candidates of kind correction: a user corrected the agent
    rules: int  # rules the dream wrote that week
    skills: int  # skills the dream wrote that week


class Missed(TypedDict):
    """A repeated correction: a session was corrected for something memory already had a note on."""

    title: str
    ts: str


@final
class TotalsMissed(Missed):
    """A repeated correction in the All repositories view, tagged with its repository."""

    store: str


class _ViewBase(TypedDict):
    key: str
    kinds: dict[str, int]
    ages: dict[str, int]
    superseded: int
    skills: list[Skill]
    index_tiers: dict[str, int]
    last_update: str
    lookalikes: int
    funnel: stats.Funnel
    reading: Reading
    weeks: list[Week]  # oldest first, every week from the first session to the last, at most WEEKS of them


@final
class StoreView(_ViewBase):
    """One repository: what `collect.collect_store` returns."""

    notes: list[Note]
    promotion: Promotion
    missed: list[Missed]  # newest first


@final
class TotalsView(_ViewBase):
    """All repositories: what `collect.totals` returns."""

    notes: list[TotalsNote]
    promotion: PromotionTotals
    missed: list[TotalsMissed]  # newest first, across repositories


View = Union[StoreView, TotalsView]


class Page(TypedDict):
    """What `collect.collect` returns and `render.render` takes."""

    stores: list[StoreView]
    errors: list[tuple[str, str]]  # store, error
    generated: str
    root: str
    all: TotalsView
