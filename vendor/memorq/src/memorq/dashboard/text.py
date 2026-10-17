"""Small text helpers shared by the dashboard's messages and its HTML. No HTML here, no store access."""

from __future__ import annotations

__all__ = ['plural']


def plural(count: int, one: str, many: str = '') -> str:
    """`count` and the noun: `1 note`, `2 notes`; `many` for an irregular plural."""
    return f'{count} {one if count == 1 else many or one + "s"}'
