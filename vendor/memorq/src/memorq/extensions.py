"""Implementations by name: a built-in from a registry, or `package.module:attr` from outside the plugin.

An outside implementation is imported by the python3 that runs the hooks, so its package must be on that
interpreter's path: installed for it, or put on PYTHONPATH in the environment that starts the agent.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

__all__ = ['resolve']


def resolve(spec: str, builtins: Mapping[str, Any]) -> Any:
    """`builtins[spec]`, or the attribute that `package.module:attr` names.

    Raises ValueError for a spec that is neither, and ImportError or AttributeError when the import fails.
    """
    if spec in builtins:
        return builtins[spec]
    module, sep, attr = spec.partition(':')
    if not (sep and module and attr):
        raise ValueError(f'{spec!r} is neither one of {", ".join(sorted(builtins))} nor package.module:attr')
    return getattr(importlib.import_module(module), attr)
