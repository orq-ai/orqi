"""The one-time move of the stores from ~/.orq/knowledge to ~/.memorq, where they live now.

A rename and a link, never a copy and never a delete: the stores move in one step on the same filesystem, and the old
path keeps working for anything that still reads it (scripts, a pinned older plugin). When the rename fails (another
filesystem, permissions), nothing moves and this process keeps using the old path. A ~/.orq/knowledge that is itself a
link (a synced folder, a dotfiles setup) is never renamed: ~/.memorq becomes a link to the folder it leads to. It runs
once per process, from hooks.handle, cli.main and the dashboard, and only for the default root: ORQ_NOTES_HOME, or a
ROOT set in-process (the tests, the research eval), is a root someone chose, and the user's real stores are never moved
into it.
"""

from __future__ import annotations

import os
import sys

from . import settings

__all__ = ['move_root']

_done = False  # once per process; a test resets it


def move_root() -> str | None:
    """Move LEGACY_ROOT to ROOT and leave a link behind (or link ROOT to a linked LEGACY_ROOT's folder); the message it
    printed, or None when nothing moved."""
    global _done
    if _done:
        return None
    _done = True
    root, legacy = settings.ROOT, settings.LEGACY_ROOT
    if os.getenv('ORQ_NOTES_HOME') or root != legacy.parent.parent / '.memorq':  # a root someone chose
        return None
    if root.exists():
        if legacy.exists() and not legacy.is_symlink():
            print('memorq: ~/.orq/knowledge still exists beside ~/.memorq; it is no longer read', file=sys.stderr)
        return None
    if not legacy.exists():  # missing, or a link that leads nowhere
        return None
    if legacy.is_symlink():  # never renamed: a relative target would then resolve from the wrong folder
        return _link_to(os.path.realpath(legacy))
    try:
        os.rename(legacy, root)  # noqa: PTH104 (os, as a test fakes a failed rename on it)
    except OSError as e:
        settings.ROOT = legacy
        print(f'memorq: could not move ~/.orq/knowledge to ~/.memorq ({e}); still using the old path', file=sys.stderr)
        return None
    message = 'memorq: moved ~/.orq/knowledge to ~/.memorq (a link stays behind)'
    try:
        os.symlink(root, legacy)
    except OSError as e:  # the stores did move; only the old path is gone
        message = f'memorq: moved ~/.orq/knowledge to ~/.memorq (no link left behind: {e})'
    print(message, file=sys.stderr)
    return message


def _link_to(target: str) -> str | None:
    """ROOT as a link to the folder a linked LEGACY_ROOT leads to; that link stays as it was."""
    try:
        os.symlink(target, settings.ROOT)
    except OSError as e:
        settings.ROOT = settings.LEGACY_ROOT
        print(f'memorq: could not link ~/.memorq to {target} ({e}); still using the old path', file=sys.stderr)
        return None
    message = f'memorq: linked ~/.memorq to {target} (~/.orq/knowledge was already a link)'
    print(message, file=sys.stderr)
    return message
