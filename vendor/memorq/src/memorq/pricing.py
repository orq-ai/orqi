"""The price of a router learn, from the workspace's model catalogue (`GET /v2/models`), as orqi prices its turns.

The router does not price its responses, so `llm.orq_chat` asks `price`. The catalogue is cached as the raw response in
`<ROOT>/models.json` for a day. Never raises into a learn: on any failure the stale cache answers, else no model is
priced (None), with one stderr line per process.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from typing import TYPE_CHECKING, Any

from . import embeddings, settings

if TYPE_CHECKING:
    from pathlib import Path

__all__ = ['CACHE_S', 'api_base', 'catalogue', 'price']

CACHE_S = 86_400  # by the cache file's mtime
_warned = False  # whether this process has said the catalogue is unavailable


def api_base() -> str:
    """The API host the router lives on: settings.ROUTER without its `/v2/router` or `/v3/router`."""
    return re.sub(r'/v[23]/router/?$', '', settings.ROUTER)


def _cache() -> Path:
    return settings.ROOT / 'models.json'  # at call time: the root move can reassign ROOT


def _number(value: object) -> float:
    """A number as a float; anything else (missing, null, a string) is 0."""
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def _prices(raw: object) -> dict[str, tuple[float, float, float]]:
    """Model id → (input, output, cache-read) USD per million tokens, mapped as orqi's `modelInfo` maps an entry.

    TypeError when `raw` is not a list; an entry that names no model is skipped. A disabled model is kept: learns it
    wrote before it was disabled still have a price.
    """
    if not isinstance(raw, list):
        raise TypeError(f'a JSON {type(raw).__name__}, not a list')
    prices: dict[str, tuple[float, float, float]] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get('refId') or (
            f'{entry["provider"]}/{entry["model_id"]}' if entry.get('provider') and entry.get('model_id') else ''
        )
        if not isinstance(model_id, str) or not model_id:
            continue
        meta = entry.get('metadata')
        meta = meta if isinstance(meta, dict) else {}
        prices[model_id] = (
            _number(meta.get('million_tokens_input_cost')),
            _number(meta.get('million_tokens_output_cost')),
            _number(meta.get('million_tokens_cache_read_cost')),
        )
    return prices


def _cached(path: Path) -> dict[str, tuple[float, float, float]] | None:
    """The cached catalogue, or None when there is no readable one."""
    try:
        return _prices(json.loads(path.read_text(encoding='utf-8')))
    except (OSError, ValueError, TypeError):  # ValueError covers bad JSON and bad UTF-8
        return None


def _fetch(path: Path) -> dict[str, tuple[float, float, float]]:
    """The catalogue from the API, written to `path` as the raw list when its folder exists. Raises on any failure."""
    if not (key := embeddings.api_key()):
        raise RuntimeError('no key (~/.orq/api-key or ORQ_API_KEY)')
    headers = {'Authorization': f'Bearer {key}', 'x-client-type': 'memorq'}
    req = urllib.request.Request(f'{api_base()}/v2/models', headers=headers)  # noqa: S310 (configured https URL)
    with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
        raw = json.loads(resp.read())
    prices = _prices(raw)
    if path.parent.is_dir():  # never creates ROOT: migrate.move_root does not move the stores into one that exists
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(raw), encoding='utf-8')
        tmp.replace(path)  # never a half-written cache
    return prices


def catalogue() -> dict[str, tuple[float, float, float]]:
    """Model id → (input, output, cache-read) USD per million tokens: the cache when younger than CACHE_S, else the
    API's. On any failure the stale cache, else {}. Never raises."""
    global _warned  # one stderr line per process
    path = _cache()
    try:
        fresh = time.time() - path.stat().st_mtime < CACHE_S
    except OSError:
        fresh = False
    if fresh and (prices := _cached(path)) is not None:
        return prices
    try:
        return _fetch(path)
    except Exception as e:  # a learn is never failed by its price
        if (prices := _cached(path)) is not None:
            return prices
        if not _warned:
            _warned = True
            print(
                f'memorq: catalogue unavailable ({str(e)[:200] or type(e).__name__}); learns are unpriced',
                file=sys.stderr,
            )
        return {}


def price(model: str, usage: dict[str, Any]) -> float | None:
    """USD for `usage` (Claude's token keys) on `model` (`orq/` prefix optional); None when the catalogue has no such
    model."""
    if (rates := catalogue().get(model.removeprefix('orq/'))) is None:
        return None
    tokens = (_number(usage.get(k)) for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens'))
    return round(sum(rate * n for rate, n in zip(rates, tokens)) / 1e6, 6)
