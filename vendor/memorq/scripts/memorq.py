#!/usr/bin/env python3
"""memorq entry point: `python3 scripts/memorq.py <command>`. Commands: see `src/memorq/cli.py`.

The code lives in the `memorq` package in `src/`; this file puts `src/` on the import path and runs `memorq.cli`. Code
that uses the plugin as a library imports `memorq` with `<plugin>/src` on `sys.path`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / 'src'
if sys.path[:1] != [str(_SRC)]:
    # memorq is in this checkout's src/, whatever the cwd. First on the path, ahead of this file's own folder, where
    # `import memorq` would find this script instead of the package.
    sys.path.insert(0, str(_SRC))

import memorq
from memorq import cli

# A second plugin checkout loaded by path in this process would otherwise silently run the first checkout's code.
if Path(memorq.__file__).resolve().parent != _SRC / 'memorq':
    raise ImportError(
        f'{__file__} needs the memorq of its checkout ({_SRC / "memorq"}), but memorq is {memorq.__file__}'
    )

if __name__ == '__main__':
    cli.main()
