#!/usr/bin/env python3
"""Memory dashboard entry point: `python3 scripts/dashboard.py [--root DIR] [--out FILE] [--open]`.

The code lives in `memorq.dashboard` in `src/` (collect, render, page.css, page.js); this file puts `src/` on the import
path and runs its `main`. `memorq.py dashboard ...` runs the same `main`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / 'src'
if sys.path[:1] != [str(_SRC)]:
    # memorq is in this checkout's src/, whatever the cwd. First on the path, ahead of this file's own folder, where
    # `import memorq` would find scripts/memorq.py instead of the package.
    sys.path.insert(0, str(_SRC))

import memorq
from memorq.dashboard import main

# A second plugin checkout loaded by path in this process would otherwise silently run the first checkout's code.
if Path(memorq.__file__).resolve().parent != _SRC / 'memorq':
    raise ImportError(
        f'{__file__} needs the memorq of its checkout ({_SRC / "memorq"}), but memorq is {memorq.__file__}'
    )

__all__ = ['main']

if __name__ == '__main__':
    main()
