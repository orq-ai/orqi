"""Detached child processes: hook timeouts are short, consolidation and the dream take a minute."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from . import settings

__all__ = ['ENTRY', 'spawn']

ENTRY = Path(__file__).resolve().parents[2] / 'scripts' / 'memorq.py'  # re-run the CLI, never this module


def spawn(args: list[str]) -> None:
    """Run this script detached: hook timeouts are short and consolidation takes a minute."""
    settings.ROOT.mkdir(parents=True, exist_ok=True)
    with (settings.ROOT / 'hook.log').open('a') as log:
        subprocess.Popen(
            [sys.executable, str(ENTRY), *args],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
            env={**os.environ, 'ORQ_NOTES_HOME': str(settings.ROOT)},  # ROOT may be set in-process, not in the env
        )
