"""Log records: what a consolidation, dream or promotion line in log.jsonl holds, and safe ways to walk it."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

__all__ = ['sessions', 'valid_decisions']


def sessions(log: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The session records of a log (a consolidation, skipped or failed): not a dream, not a promotion."""
    return [r for r in log if not r.get('dream') and 'promoted' not in r]


def valid_decisions(
    decisions: list[dict[str, Any]], candidates: list[dict[str, Any]]
) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
    """(decision, candidate) for every decision whose `index` points at a candidate; the others are skipped.

    Yields:
        The (decision, candidate) pairs, in the order of the decisions.
    """
    for d in decisions:
        i = d.get('index')
        if isinstance(i, int) and 0 <= i < len(candidates):
            yield d, candidates[i]
