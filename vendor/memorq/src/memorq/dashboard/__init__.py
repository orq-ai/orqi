"""Memory dashboard: one self-contained HTML page with the statistics of every knowledge-note store.

Standard library only, Python 3.9+, no model calls. Reads ~/.memorq/<store>/{notes,skills,superseded,log.jsonl,
state.json}, writes <root>/dashboard.html (or --out). The numbers come from the same functions the plugin uses:
memorq.index for the session-start index tiers, human_edited for hand edits, the DREAM_* thresholds for readiness.

`collect` turns the stores into plain dicts, `attention` picks what needs attention, `render` turns the dicts into the
page (its styles and script in page.css and page.js, inlined), and `main` is the command line:
`python3 scripts/dashboard.py [--root DIR] [--out FILE] [--open]`, or `memorq.py dashboard ...`.
"""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from .. import migrate, settings
from . import collect, render

__all__ = ['DESCRIPTION', 'collect', 'main', 'render']

DESCRIPTION = (
    'Write the memory dashboard: one HTML page with the statistics of every knowledge-note store under --root (what'
    ' was written, read, rejected and promoted, and every note). The page is self-contained; building it makes no'
    ' model calls and nothing leaves this machine.'
)


def main(argv: list[str] | None = None) -> Path:
    """Write the page for the stores under --root (default: ORQ_NOTES_HOME) to --out; with --open, open it."""
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument('--root', type=Path, help='where the stores live (default: ORQ_NOTES_HOME or ~/.memorq)')
    parser.add_argument('--out', type=Path, help='output file (default: <root>/dashboard.html)')
    parser.add_argument('--open', action='store_true', help='open the page in the default browser')
    args = parser.parse_args(argv)
    if args.root is None:  # the default root: move ~/.orq/knowledge first, scripts/dashboard.py skips cli.main
        migrate.move_root()
    root: Path = args.root or settings.ROOT
    out: Path = args.out or root / 'dashboard.html'
    root.mkdir(parents=True, exist_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render.render(collect.collect(root)), encoding='utf-8')
    print(f'Dashboard written to {out}')
    if args.open:
        webbrowser.open(out.resolve().as_uri())
    return out
