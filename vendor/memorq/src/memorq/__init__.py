"""memorq: repository memory for coding agents (the package behind scripts/memorq.py).

Modules import each other as modules (`from . import settings`) and use qualified names (`settings.ROOT`), so a value
set on one module (`settings.ROOT = path`, a test's monkeypatch) is seen by every caller. Never
`from .settings import ROOT`.
"""

__all__: list[str] = []
